-- ============================================================
-- 001_init.sql  —  Ledger schema
-- ============================================================

CREATE TABLE IF NOT EXISTS accounts (
    id          TEXT           PRIMARY KEY,
    balance     NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    version     BIGINT         NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger (
    id             BIGSERIAL      PRIMARY KEY,
    txn_id         TEXT           NOT NULL UNIQUE,
    from_account   TEXT           NOT NULL,
    to_account     TEXT           NOT NULL,
    amount         NUMERIC(20, 0) NOT NULL CHECK (amount > 0),
    prev_hash      CHAR(64)       NOT NULL,
    entry_hash     CHAR(64)       NOT NULL,
    created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency (
    txn_id      TEXT        PRIMARY KEY,
    status      INTEGER     NOT NULL,
    body        JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only enforcement via RULES.
CREATE OR REPLACE RULE ledger_no_update AS
    ON UPDATE TO ledger DO INSTEAD NOTHING;

CREATE OR REPLACE RULE ledger_no_delete AS
    ON DELETE TO ledger DO INSTEAD NOTHING;
