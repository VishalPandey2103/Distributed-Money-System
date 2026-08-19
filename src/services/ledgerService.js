import { pool } from '../config/db.js';
import { redis } from '../config/redis.js';
import * as accountModel from '../models/accountModel.js';
import * as ledgerModel from '../models/ledgerModel.js';
import * as idemModel from '../models/idempotencyModel.js';
import { verifyChain } from './hashService.js';
import { getRaftNode } from '../raft/raftNode.js';

const IDEM_TTL = Number(process.env.IDEMPOTENCY_TTL_SECONDS || 86400);

export class AppError extends Error {
    constructor(code, statusCode, message, details) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}

export class NotLeaderError extends Error {
    constructor(leaderId, leaderHttp) {
        super('NOT_LEADER');
        this.code = 'NOT_LEADER';
        this.statusCode = 421; // Misdirected Request — client should retry against leaderHttp
        this.leaderId = leaderId;
        this.leaderHttp = leaderHttp;
    }
}

// ---------------- Accounts ----------------
// Account creation is NOT routed through Raft in v2. Reason: it's
// idempotent by primary key and doesn't need cross-node ordering.
// The tradeoff is that accounts must be created explicitly on every
// node before transfers can reference them across the cluster.
// A production system would fold account creation into the Raft log
// too — trivial extension, punted here to keep v2 focused.

export async function createAccount({ accountId, openingBalancePaise }) {
    const row = await accountModel.insertAccount(pool, {
        accountId, balance: openingBalancePaise,
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

// ---------------- Transfer via Raft ----------------

export async function transfer({ txnId, fromAccount, toAccount, amountPaise }) {
    if (fromAccount === toAccount) {
        throw new AppError('SAME_ACCOUNT', 400, 'from and to must differ');
    }

    // Redis fast path — safe because the state machine is the
    // ground truth for idempotency and only serves committed
    // responses. If Redis says "we already did this", the response
    // came from a state-machine apply that was already committed.
    const cachedRaw = await safeRedisGet(`idem:${txnId}`);
    if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        return { cached: true, source: 'redis', ...cached };
    }

    const node = getRaftNode();
    if (!node) throw new AppError('NOT_READY', 503, 'raft node not initialized');

    // If we already applied this on THIS node (state machine wrote
    // idempotency), return that. This handles the case where
    // Redis is cold but Postgres has the record.
    const pgIdem = await idemModel.findIdempotencyKey(pool, txnId);
    if (pgIdem) {
        const response = { status: pgIdem.status, body: pgIdem.body };
        await safeRedisSet(`idem:${txnId}`, JSON.stringify(response));
        return { cached: true, source: 'postgres', ...response };
    }

    // Propose through Raft. Throws NOT_LEADER if we're not the leader.
    let proposalResult;
    try {
        proposalResult = await node.propose({
            type: 'transfer',
            txnId, fromAccount, toAccount,
            amountPaise: amountPaise.toString(),
        });
    } catch (err) {
        if (err.code === 'NOT_LEADER') {
            throw new NotLeaderError(err.leaderId, err.leaderHttp);
        }
        throw err;
    }

    const applied = proposalResult.applied;

    // Apply result shape: { ok, status?, body, cached?, unknown? }
    if (!applied.ok) {
        // Domain rejection — surface as AppError so the middleware
        // returns the right status code.
        const body = applied.body;
        const err = new AppError(
            body.error?.code || 'APPLY_FAILED',
            applied.status || 400,
            body.error?.message || 'apply failed',
            body.error?.details
        );
        throw err;
    }

    const response = { status: applied.status || 200, body: applied.body };
    await safeRedisSet(`idem:${txnId}`, JSON.stringify(response));

    return {
        cached: !!applied.cached,
        source: applied.cached ? 'postgres' : 'fresh',
        ...response,
    };
}

// ---------------- Verify chain ----------------

export async function verifyLedger() {
    const rows = await ledgerModel.fetchAllOrdered(pool, { limit: 1_000_000 });
    return verifyChain(rows);
}

// ---------------- Redis helpers ----------------
async function safeRedisGet(key) {
    try { return await redis.get(key); } catch { return null; }
}
async function safeRedisSet(key, value) {
    try { await redis.set(key, value, 'EX', IDEM_TTL); } catch { /* non-fatal */ }
}
