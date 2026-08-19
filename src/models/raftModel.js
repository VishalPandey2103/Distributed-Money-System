// Raw DB queries for raft_meta + raft_log.
// Every write must be committed to disk BEFORE responding to the RPC
// that produced it (Figure 2 of the paper). We rely on Postgres
// synchronous_commit=on for that guarantee.

export async function loadMeta(db) {
    const res = await db.query(
        `SELECT current_term, voted_for, last_applied_index
         FROM raft_meta WHERE id = 1`
    );
    const r = res.rows[0];
    return {
        currentTerm: BigInt(r.current_term),
        votedFor: r.voted_for,
        lastAppliedIndex: BigInt(r.last_applied_index),
    };
}

export async function setTermAndVote(db, { currentTerm, votedFor }) {
    await db.query(
        `UPDATE raft_meta
         SET current_term = $1, voted_for = $2, updated_at = NOW()
         WHERE id = 1`,
        [currentTerm.toString(), votedFor]
    );
}

export async function setLastAppliedIndex(db, idx) {
    await db.query(
        `UPDATE raft_meta SET last_applied_index = $1, updated_at = NOW() WHERE id = 1`,
        [idx.toString()]
    );
}

// ---------------- Log ----------------

export async function lastLogEntry(db) {
    const res = await db.query(
        `SELECT log_index, term FROM raft_log ORDER BY log_index DESC LIMIT 1`
    );
    if (res.rows.length === 0) return { index: 0n, term: 0n };
    return { index: BigInt(res.rows[0].log_index), term: BigInt(res.rows[0].term) };
}

export async function logEntryAt(db, index) {
    if (index === 0n) return { index: 0n, term: 0n, entryType: 'sentinel', command: null };
    const res = await db.query(
        `SELECT log_index, term, entry_type, command_json
         FROM raft_log WHERE log_index = $1`,
        [index.toString()]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
        index: BigInt(r.log_index),
        term: BigInt(r.term),
        entryType: r.entry_type,
        command: r.command_json,
    };
}

export async function entriesFrom(db, startIndex, limit) {
    const res = await db.query(
        `SELECT log_index, term, entry_type, command_json
         FROM raft_log
         WHERE log_index >= $1
         ORDER BY log_index ASC
         LIMIT $2`,
        [startIndex.toString(), limit]
    );
    return res.rows.map((r) => ({
        index: BigInt(r.log_index),
        term: BigInt(r.term),
        entryType: r.entry_type,
        command: r.command_json,
    }));
}

export async function appendEntry(db, { index, term, entryType, command }) {
    await db.query(
        `INSERT INTO raft_log (log_index, term, entry_type, command_json)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [index.toString(), term.toString(), entryType, command === null ? null : JSON.stringify(command)]
    );
}

// Delete all entries at index >= fromIndex. Used when follower's log
// conflicts with leader's log (paper §5.3).
export async function truncateFrom(db, fromIndex) {
    await db.query(
        `DELETE FROM raft_log WHERE log_index >= $1`,
        [fromIndex.toString()]
    );
}

// Find the first index in `term` — used for the conflict-index
// optimization when replying to AppendEntries.
export async function firstIndexInTerm(db, term) {
    const res = await db.query(
        `SELECT MIN(log_index) AS mi FROM raft_log WHERE term = $1`,
        [term.toString()]
    );
    const mi = res.rows[0].mi;
    return mi == null ? null : BigInt(mi);
}
