import crypto from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

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
