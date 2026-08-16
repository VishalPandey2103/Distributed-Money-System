// Raw DB queries for ledger. Append-only WAL, source of truth.

export async function getChainTip(db) {
    const res = await db.query(
        `SELECT id, entry_hash FROM ledger ORDER BY id DESC LIMIT 1`
    );
    return res.rows[0] || null;
}

export async function insertLogEntry(db, entry) {
    const res = await db.query(
        `INSERT INTO ledger
           (txn_id, from_account, to_account, amount, prev_hash, entry_hash)
         VALUES ($1, $2, $3, $4::numeric, $5, $6)
         RETURNING id, created_at`,
        [
            entry.txnId,
            entry.fromAccount,
            entry.toAccount,
            entry.amount.toString(),
            entry.prevHash,
            entry.entryHash,
        ]
    );
    return res.rows[0];
}

export async function countEntries(db) {
    const res = await db.query(`SELECT COUNT(*)::bigint AS c FROM ledger`);
    return BigInt(res.rows[0].c);
}

export async function fetchAllOrdered(db, { limit = 1000, afterId = 0 } = {}) {
    const res = await db.query(
        `SELECT id, txn_id, from_account, to_account, amount,
                prev_hash, entry_hash, created_at
         FROM ledger
         WHERE id > $1
         ORDER BY id ASC
         LIMIT $2`,
        [afterId, limit]
    );
    return res.rows;
}
