import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { pool, shutdownDb } from '../src/config/db.js';
import { redis, shutdownRedis } from '../src/config/redis.js';
import * as ledgerService from '../src/services/ledgerService.js';
import { hashEntry, GENESIS_HASH } from '../src/services/hashService.js';

// Test IDs are scoped per-run so tests don't collide with prior data.
const RUN = randomUUID().slice(0, 8);
const A = `A_${RUN}`;
const B = `B_${RUN}`;

before(async () => {
    // Clean any prior test rows for this run prefix (defensive).
    await pool.query(`DELETE FROM idempotency WHERE txn_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM accounts WHERE id IN ($1,$2)`, [A, B]);
});

after(async () => {
    await shutdownRedis().catch(() => {});
    await shutdownDb().catch(() => {});
});

test('create accounts', async () => {
    const a = await ledgerService.createAccount({ accountId: A, openingBalancePaise: 1000_00n });
    const b = await ledgerService.createAccount({ accountId: B, openingBalancePaise: 0n });
    assert.equal(a.balancePaise, 100000n);
    assert.equal(b.balancePaise, 0n);
});

test('transfer moves money and hash-chains', async () => {
    const txnId = `${RUN}_t1`;
    const r = await ledgerService.transfer({
        txnId,
        fromAccount: A,
        toAccount: B,
        amountPaise: 250_00n,
    });
    assert.equal(r.cached, false);
    assert.equal(r.body.amountPaise, '25000');

    const a = await ledgerService.getAccount(A);
    const b = await ledgerService.getAccount(B);
    assert.equal(a.balancePaise, 75000n);
    assert.equal(b.balancePaise, 25000n);

    // Recompute the hash and match it against stored entry.
    const recomputed = hashEntry({
        prevHash: r.body.prevHash,
        txnId,
        fromAccount: A,
        toAccount: B,
        amount: 25000n,
    });
    assert.equal(recomputed, r.body.entryHash);
});

test('idempotency: replay returns cached response', async () => {
    const txnId = `${RUN}_t2`;
    const first = await ledgerService.transfer({
        txnId, fromAccount: A, toAccount: B, amountPaise: 100n,
    });
    const second = await ledgerService.transfer({
        txnId, fromAccount: A, toAccount: B, amountPaise: 100n,
    });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(first.body.entryHash, second.body.entryHash);
});

test('insufficient balance rejected', async () => {
    await assert.rejects(
        ledgerService.transfer({
            txnId: `${RUN}_t3`,
            fromAccount: B,
            toAccount: A,
            amountPaise: 999_999_00n,
        }),
        (err) => err.code === 'INSUFFICIENT_BALANCE'
    );
});

test('same-account transfer rejected', async () => {
    await assert.rejects(
        ledgerService.transfer({
            txnId: `${RUN}_t4`,
            fromAccount: A,
            toAccount: A,
            amountPaise: 1n,
        }),
        (err) => err.code === 'SAME_ACCOUNT'
    );
});

test('verifyLedger returns ok for untampered chain', async () => {
    const v = await ledgerService.verifyLedger();
    assert.equal(v.ok, true);
});
