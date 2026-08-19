import { withTx } from '../config/db.js';
import * as raftModel from '../models/raftModel.js';
import * as accountModel from '../models/accountModel.js';
import * as ledgerModel from '../models/ledgerModel.js';
import * as idemModel from '../models/idempotencyModel.js';
import { hashEntry, GENESIS_HASH } from './hashService.js';

// The state machine. Every replica runs `apply(command, appliedIndex)`
// for every committed log entry, in order, exactly once.
//
// The APPLY MUST BE DETERMINISTIC. That means:
//   - No wall-clock reads that differ across replicas (we use
//     Postgres NOW() for created_at, which differs slightly per
//     replica; that's acceptable because we don't chain-hash the
//     timestamp — only txnId + accounts + amount + prev_hash).
//   - No random numbers.
//   - Domain rejections (insufficient balance, unknown account) are
//     recorded as applied outcomes — every replica reaches the same
//     conclusion because the command sees the same state.
//
// Exactly-once semantics: we advance last_applied_index in the SAME
// Postgres transaction that mutates accounts and ledger.
// So on restart, we replay only entries strictly greater than the
// persisted last_applied_index.

export const stateMachine = {
    async apply(command, appliedIndex) {
        if (!command || command.type !== 'transfer') {
            // Unknown command types are recorded as no-op successes so
            // future versions don't stall replay if they encounter
            // legacy shapes.
            return await withTx(async (client) => {
                await raftModel.setLastAppliedIndex(client, appliedIndex);
                return { ok: true, unknown: true };
            });
        }

        const { txnId, fromAccount, toAccount, amountPaise } = command;
        const amt = BigInt(amountPaise);

        return await withTx(async (client) => {
            // 1. Idempotency check — if we've already applied this
            // txnId (possibly on a previous leader that also had this
            // entry committed), return the cached response.
            const existing = await idemModel.findIdempotencyKey(client, txnId);
            if (existing) {
                await raftModel.setLastAppliedIndex(client, appliedIndex);
                return { ok: true, cached: true, body: existing.body };
            }

            // 2. Same-account guard — should have been caught before
            // proposing, but state machine is the last line of defense.
            if (fromAccount === toAccount) {
                const body = { error: { code: 'SAME_ACCOUNT', message: 'from and to must differ' } };
                await idemModel.insertIdempotencyKey(client, {
                    txnId, statusCode: 400, responseBody: body,
                });
                await raftModel.setLastAppliedIndex(client, appliedIndex);
                return { ok: false, status: 400, body };
            }

            // 3. Lock both accounts deterministically.
            const rows = await accountModel.lockAccountsForUpdate(
                client, [fromAccount, toAccount]
            );
            const byId = new Map(rows.map((r) => [r.id, r]));
            const from = byId.get(fromAccount);
            const to = byId.get(toAccount);
            if (!from || !to) {
                const missing = !from ? fromAccount : toAccount;
                const body = {
                    error: {
                        code: 'ACCOUNT_NOT_FOUND',
                        message: `account "${missing}" not found`,
                    },
                };
                await idemModel.insertIdempotencyKey(client, {
                    txnId, statusCode: 404, responseBody: body,
                });
                await raftModel.setLastAppliedIndex(client, appliedIndex);
                return { ok: false, status: 404, body };
            }

            const fromBal = BigInt(from.balance);
            if (fromBal < amt) {
                const body = {
                    error: {
                        code: 'INSUFFICIENT_BALANCE',
                        message: `balance ${fromBal} < amount ${amt}`,
                    },
                };
                await idemModel.insertIdempotencyKey(client, {
                    txnId, statusCode: 400, responseBody: body,
                });
                await raftModel.setLastAppliedIndex(client, appliedIndex);
                return { ok: false, status: 400, body };
            }

            // 4. Chain-hash and append to ledger. Because the
            // Raft log has already ordered this entry, no advisory
            // lock is needed here — no other apply() is running
            // concurrently (apply loop is single-threaded per node).
            const tip = await ledgerModel.getChainTip(client);
            const prevHash = tip ? tip.entry_hash : GENESIS_HASH;
            const entryHash = hashEntry({
                prevHash, txnId, fromAccount, toAccount, amount: amt,
            });

            const inserted = await ledgerModel.insertLogEntry(client, {
                txnId, fromAccount, toAccount, amount: amt,
                prevHash, entryHash,
            });

            await accountModel.debitAccount(client, fromAccount, amt);
            await accountModel.creditAccount(client, toAccount, amt);

            const body = {
                txnId,
                logId: inserted.id.toString(),
                fromAccount,
                toAccount,
                amountPaise: amt.toString(),
                prevHash,
                entryHash,
                createdAt: inserted.created_at,
                raftIndex: appliedIndex.toString(),
            };

            await idemModel.insertIdempotencyKey(client, {
                txnId, statusCode: 200, responseBody: body,
            });

            // 5. Advance last_applied_index in the SAME transaction.
            // This is the linchpin of exactly-once apply.
            await raftModel.setLastAppliedIndex(client, appliedIndex);

            return { ok: true, status: 200, body };
        });
    },
};
