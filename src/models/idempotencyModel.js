// Idempotency ground truth. Redis is the fast path; this is authoritative.

export async function findIdempotencyKey(db, txnId) {
    const res = await db.query(
        `SELECT txn_id, status, body, created_at
         FROM idempotency WHERE txn_id = $1`,
        [txnId]
    );
    return res.rows[0] || null;
}

export async function insertIdempotencyKey(db, { txnId, statusCode, responseBody }) {
    const res = await db.query(
        `INSERT INTO idempotency (txn_id, status, body)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (txn_id) DO NOTHING
         RETURNING txn_id`,
        [txnId, statusCode, JSON.stringify(responseBody)]
    );
    return res.rowCount > 0;
}
