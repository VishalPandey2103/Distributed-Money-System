import crypto from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

// Domain-separated hash of a ledger entry. Field order is a schema —
// changing it invalidates every existing chain.
export function hashEntry({ prevHash, txnId, fromAccount, toAccount, amount }) {
    if (prevHash.length !== 64) {
        throw new Error(`prevHash must be 64 hex chars, got ${prevHash.length}`);
    }
    const payload = [
        prevHash,
        txnId,
        fromAccount,
        toAccount,
        amount.toString(),
    ].join('|');
    return crypto.createHash('sha256').update(payload).digest('hex');
}

// Verify a full chain slice. Returns { ok, brokenAtId?, reason? }.
export function verifyChain(entries, startingPrev = GENESIS_HASH) {
    let prev = startingPrev;
    for (const e of entries) {
        if (e.prev_hash !== prev) {
            return { ok: false, brokenAtId: Number(e.id), reason: 'prev_hash mismatch' };
        }
        const computed = hashEntry({
            prevHash: e.prev_hash,
            txnId: e.txn_id,
            fromAccount: e.from_account,
            toAccount: e.to_account,
            amount: BigInt(e.amount),
        });
        if (computed !== e.entry_hash) {
            return { ok: false, brokenAtId: Number(e.id), reason: 'entry_hash mismatch' };
        }
        prev = e.entry_hash;
    }
    return { ok: true };
}
