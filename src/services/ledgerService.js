import { pool, withTx } from '../config/db.js';
import { redis } from '../config/redis.js';
import { hashEntry, GENESIS_HASH, verifyChain } from './hashService.js';
import * as accountModel from '../models/accountModel.js';
import * as ledgerModel from '../models/ledgerModel.js';
import * as idemModel from '../models/idempotencyModel.js';

const IDEM_TTL = Number(process.env.IDEMPOTENCY_TTL_SECONDS || 86400);

export class AppError extends Error {
    constructor(code, statusCode, message, details) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}

// ---------------- Accounts ----------------

export async function createAccount({ accountId, openingBalancePaise }) {
    const row = await accountModel.insertAccount(pool, {
        accountId,
        balance: openingBalancePaise,
    });
    if (!row) {
        throw new AppError('ACCOUNT_EXISTS', 409, `account "${accountId}" already exists`);
    }
    return {
        accountId: row.id,
        balancePaise: BigInt(row.balance),
        version: Number(row.version),
        updatedAt: row.updated_at,
    };
}

export async function getAccount(accountId) {
    const row = await accountModel.findAccountById(pool, accountId);
    if (!row) throw new AppError('ACCOUNT_NOT_FOUND', 404, `account "${accountId}" not found`);
    return {
        accountId: row.id,
        balancePaise: BigInt(row.balance),
        version: Number(row.version),
        updatedAt: row.updated_at,
    };
}

// ---------------- Transfer ----------------

export async function transfer({ txnId, fromAccount, toAccount, amountPaise }) {
    if (fromAccount === toAccount) {
        throw new AppError('SAME_ACCOUNT', 400, 'from and to must differ');
    }

    // Fast path: Redis idempotency cache.
    const cachedRaw = await safeRedisGet(`idem:${txnId}`);
    if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        return { cached: true, source: 'redis', ...cached };
    }

    const result = await withTx(async (client) => {
        // Serialize concurrent duplicate txnIds. Xact-scoped lock releases on COMMIT/ROLLBACK.
        await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
            [txnId]
        );

        // Ground-truth idempotency check inside the lock.
        const idemRow = await idemModel.findIdempotencyKey(client, txnId);
        if (idemRow) {
            return {
                cached: true,
                source: 'postgres',
                status: idemRow.status,
                body: idemRow.body,
            };
        }

        // Deterministic-order account locking.
        const accountRows = await accountModel.lockAccountsForUpdate(
            client,
            [fromAccount, toAccount]
        );
        const byId = new Map(accountRows.map((r) => [r.id, r]));
        const from = byId.get(fromAccount);
        const to = byId.get(toAccount);
        if (!from) {
            throw new AppError('FROM_NOT_FOUND', 404, `from account "${fromAccount}" not found`);
        }
        if (!to) {
            throw new AppError('TO_NOT_FOUND', 404, `to account "${toAccount}" not found`);
        }

        const fromBal = BigInt(from.balance);
        if (fromBal < amountPaise) {
            throw new AppError(
                'INSUFFICIENT_BALANCE',
                400,
                `balance ${fromBal} < amount ${amountPaise}`,
                { balancePaise: fromBal.toString(), amountPaise: amountPaise.toString() }
            );
        }

        // Chain-tip serialization: table lock so two txns cannot read the same tip.
        await client.query(`LOCK TABLE ledger IN SHARE ROW EXCLUSIVE MODE`);

        const tip = await ledgerModel.getChainTip(client);
        const prevHash = tip ? tip.entry_hash : GENESIS_HASH;

        const entryHash = hashEntry({
            prevHash,
            txnId,
            fromAccount,
            toAccount,
            amount: amountPaise,
        });

        const inserted = await ledgerModel.insertLogEntry(client, {
            txnId,
            fromAccount,
            toAccount,
            amount: amountPaise,
            prevHash,
            entryHash,
        });

        await accountModel.debitAccount(client, fromAccount, amountPaise);
        await accountModel.creditAccount(client, toAccount, amountPaise);

        const responseBody = {
            txnId,
            logId: inserted.id.toString(),
            fromAccount,
            toAccount,
            amountPaise: amountPaise.toString(),
            prevHash,
            entryHash,
            createdAt: inserted.created_at,
        };

        await idemModel.insertIdempotencyKey(client, {
            txnId,
            statusCode: 200,
            responseBody,
        });

        return {
            cached: false,
            source: 'fresh',
            status: 200,
            body: responseBody,
        };
    });

    // Post-commit Redis write. Only cache what Postgres durably committed.
    if (!result.cached || result.source === 'postgres') {
        await safeRedisSet(
            `idem:${txnId}`,
            JSON.stringify({ status: result.status, body: result.body })
        );
    }

    return result;
}

// ---------------- Verify chain ----------------

export async function verifyLedger() {
    const rows = await ledgerModel.fetchAllOrdered(pool, { limit: 1_000_000 });
    return verifyChain(rows);
}

// ---------------- Redis helpers ----------------
async function safeRedisGet(key) {
    try {
        return await redis.get(key);
    } catch {
        return null;
    }
}
async function safeRedisSet(key, value) {
    try {
        await redis.set(key, value, 'EX', IDEM_TTL);
    } catch {
        /* Postgres is source of truth; Redis failure is non-fatal */
    }
}
