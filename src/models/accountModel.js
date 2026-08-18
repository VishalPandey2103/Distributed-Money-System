// Raw DB queries for accounts. `db` is pool (autocommit) or client (in-tx).

export async function insertAccount(db, { accountId, balance }) {
    const res = await db.query(
        `INSERT INTO accounts (id, balance, version, updated_at)
         VALUES ($1, $2::numeric, 0, NOW())
         ON CONFLICT (id) DO NOTHING
         RETURNING id, balance, version, updated_at`,
        [accountId, balance.toString()]
    );
    return res.rows[0] || null;
}

export async function findAccountById(db, accountId) {
    const res = await db.query(
        `SELECT id, balance, version, updated_at
         FROM accounts WHERE id = $1`,
        [accountId]
    );
    return res.rows[0] || null;
}

// Sorted, deterministic FOR UPDATE prevents deadlock under concurrent transfers.
export async function lockAccountsForUpdate(db, accountIds) {
    const sorted = [...new Set(accountIds)].sort();
    const res = await db.query(
        `SELECT id, balance, version
         FROM accounts
         WHERE id = ANY($1::text[])
         ORDER BY id
         FOR UPDATE`,
        [sorted]
    );
    return res.rows;
}

export async function debitAccount(db, accountId, amount) {
    await db.query(
        `UPDATE accounts
         SET balance = balance - $1::numeric,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [amount.toString(), accountId]
    );
}

export async function creditAccount(db, accountId, amount) {
    await db.query(
        `UPDATE accounts
         SET balance = balance + $1::numeric,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [amount.toString(), accountId]
    );
}
