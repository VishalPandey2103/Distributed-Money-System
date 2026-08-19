-- ============================================================
-- 002_raft.sql — Raft persistent state (per node)
-- ============================================================
-- Every Raft node persists (currentTerm, votedFor, log[]) so it can
-- recover safely across restarts. The paper's Figure 2 lists these
-- as MUST-persist-before-responding-to-RPC. We piggyback on the same
-- Postgres that stores the state machine so applying a committed
-- entry and marking it applied happens atomically in one transaction.

-- Singleton row keyed on id=1. Enforced by CHECK.
CREATE TABLE IF NOT EXISTS raft_meta (
    id                  INTEGER      PRIMARY KEY CHECK (id = 1),
    current_term        BIGINT       NOT NULL DEFAULT 0,
    voted_for           TEXT,                          -- node id or NULL
    last_applied_index  BIGINT       NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO raft_meta (id) VALUES (1) ON CONFLICT DO NOTHING;

-- The Raft log. Index is 1-based per the paper. entry_type is
-- 'noop' for the leader's initial no-op (used to advance commit
-- index quickly on election) and 'command' for real state-machine
-- commands. command_json holds the serialized transfer command.
CREATE TABLE IF NOT EXISTS raft_log (
    log_index    BIGINT       PRIMARY KEY,
    term         BIGINT       NOT NULL,
    entry_type   TEXT         NOT NULL CHECK (entry_type IN ('command','noop')),
    command_json JSONB,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_raft_log_term ON raft_log (term);
