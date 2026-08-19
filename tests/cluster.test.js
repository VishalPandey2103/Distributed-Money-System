import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// These tests assume the 3-node docker-compose stack is running.
// They exercise leader discovery, replication, and cross-node
// balance convergence. Run with: `docker compose up -d && npm test`.

const NODES = ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'];
const RUN = randomUUID().slice(0, 8);
const A = `A_${RUN}`;
const B = `B_${RUN}`;

async function req(base, method, path, body) {
    const r = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json;
    try { json = await r.json(); } catch { json = null; }
    return { status: r.status, json, leaderHint: r.headers.get('x-leader-address') };
}

async function findLeader() {
    for (let attempt = 0; attempt < 40; attempt++) {
        for (const base of NODES) {
            const s = await req(base, 'GET', '/api/raft/status').catch(() => null);
            if (s?.json?.state === 'LEADER') return base;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('no leader elected within 20s');
}

async function transferViaAny(txnId, from, to, amountPaise) {
    // Try any node. If we get NOT_LEADER, follow the hint.
    for (const base of NODES) {
        const r = await req(base, 'POST', '/api/transfer', { txnId, from, to, amountPaise });
        if (r.status === 421 && r.json?.error?.leaderHttp) {
            return await req(r.json.error.leaderHttp, 'POST', '/api/transfer',
                { txnId, from, to, amountPaise });
        }
        if (r.status >= 200 && r.status < 300) return r;
    }
    throw new Error('transfer failed on all nodes');
}

before(async () => { await findLeader(); });

test('leader is elected', async () => {
    const leader = await findLeader();
    assert.ok(leader);
});

test('accounts created on each node (v2 does not raft-replicate account creation)', async () => {
    for (const base of NODES) {
        await req(base, 'POST', '/api/accounts', { accountId: A, openingBalancePaise: '100000' });
        await req(base, 'POST', '/api/accounts', { accountId: B, openingBalancePaise: '0' });
    }
});

test('transfer replicates to all nodes', async () => {
    const txnId = `${RUN}_r1`;
    const r = await transferViaAny(txnId, A, B, '25000');
    assert.equal(r.status, 201);

    // Give followers a heartbeat to apply.
    await new Promise((r) => setTimeout(r, 600));

    for (const base of NODES) {
        const a = await req(base, 'GET', `/api/accounts/${A}`);
        const b = await req(base, 'GET', `/api/accounts/${B}`);
        assert.equal(a.json.balancePaise, '75000', `node ${base} A balance`);
        assert.equal(b.json.balancePaise, '25000', `node ${base} B balance`);
    }
});

test('idempotent replay across nodes', async () => {
    const txnId = `${RUN}_r2`;
    const first = await transferViaAny(txnId, A, B, '100');
    const second = await transferViaAny(txnId, A, B, '100');
    assert.equal(first.json.entryHash, second.json.entryHash);
});

test('hash chain verifies on every node', async () => {
    await new Promise((r) => setTimeout(r, 600));
    for (const base of NODES) {
        const v = await req(base, 'GET', '/api/verify');
        assert.equal(v.json.ok, true, `chain broken on ${base}`);
    }
});
