import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePaise, formatRupees, bigintReplacer } from '../src/utils/money.js';
import { hashEntry, verifyChain, GENESIS_HASH } from '../src/services/hashService.js';

// Unit tests for the deterministic core: money parsing and the
// hash chain. These need no Postgres, Redis, or Raft cluster.
//
// The transfer path itself is NOT unit-testable in v2 — every write
// goes through raft.propose(), which needs a live quorum. That path
// is covered end-to-end by tests/cluster.test.js against the running
// docker-compose stack.

// ---------------- money ----------------

test('parsePaise accepts bigint, number and integer strings', () => {
    assert.equal(parsePaise(100000n), 100000n);
    assert.equal(parsePaise(25000), 25000n);
    assert.equal(parsePaise('25000'), 25000n);
    assert.equal(parsePaise('0'), 0n);
    assert.equal(parsePaise('-42'), -42n);
});

test('parsePaise rejects non-integer and unsupported input', () => {
    assert.throws(() => parsePaise('25.00'), TypeError);
    assert.throws(() => parsePaise('1e5'), TypeError);
    assert.throws(() => parsePaise(''), TypeError);
    assert.throws(() => parsePaise(null), TypeError);
    assert.throws(() => parsePaise(1.5), RangeError);
    assert.throws(() => parsePaise(Number.MAX_SAFE_INTEGER + 2), RangeError);
});

test('parsePaise enforces the NUMERIC(20,0) range', () => {
    const max = 10n ** 20n - 1n;
    assert.equal(parsePaise(max), max);
    assert.throws(() => parsePaise(max + 1n), RangeError);
    assert.throws(() => parsePaise(-(max + 1n)), RangeError);
});

test('parsePaise survives amounts past 2^53 as strings', () => {
    // The whole reason amounts stay BigInt end to end.
    const big = '9007199254740993'; // 2^53 + 1
    assert.equal(parsePaise(big).toString(), big);
});

test('formatRupees pads paise and keeps the sign', () => {
    assert.equal(formatRupees(100000n), '1000.00');
    assert.equal(formatRupees(5n), '0.05');
    assert.equal(formatRupees(0n), '0.00');
    assert.equal(formatRupees(-2550n), '-25.50');
    assert.equal(formatRupees('1234'), '12.34');
});

test('bigintReplacer makes BigInt JSON-safe', () => {
    assert.equal(
        JSON.stringify({ amountPaise: 25000n }, bigintReplacer),
        '{"amountPaise":"25000"}'
    );
});

// ---------------- hash chain ----------------

const base = {
    prevHash: GENESIS_HASH,
    txnId: 't-1',
    fromAccount: 'alice',
    toAccount: 'bob',
    amount: 25000n,
};

test('hashEntry is deterministic and 64 hex chars', () => {
    const h = hashEntry(base);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h, hashEntry({ ...base }));
});

test('hashEntry changes when any field changes', () => {
    const h = hashEntry(base);
    const variants = [
        { ...base, txnId: 't-2' },
        { ...base, fromAccount: 'bob' },
        { ...base, toAccount: 'alice' },
        { ...base, amount: 25001n },
        { ...base, prevHash: 'a'.repeat(64) },
    ];
    for (const v of variants) {
        assert.notEqual(hashEntry(v), h);
    }
});

test('hashEntry rejects a malformed prevHash', () => {
    assert.throws(() => hashEntry({ ...base, prevHash: 'abc' }), /64 hex chars/);
});

// Build a well-formed chain the way the state machine does.
function buildChain(specs) {
    let prev = GENESIS_HASH;
    return specs.map((sp, i) => {
        const entry_hash = hashEntry({ prevHash: prev, ...sp });
        const row = {
            id: i + 1,
            txn_id: sp.txnId,
            from_account: sp.fromAccount,
            to_account: sp.toAccount,
            amount: sp.amount.toString(),
            prev_hash: prev,
            entry_hash,
        };
        prev = entry_hash;
        return row;
    });
}

const specs = [
    { txnId: 't-1', fromAccount: 'alice', toAccount: 'bob', amount: 25000n },
    { txnId: 't-2', fromAccount: 'bob', toAccount: 'carol', amount: 5000n },
    { txnId: 't-3', fromAccount: 'carol', toAccount: 'alice', amount: 1n },
];

test('verifyChain accepts an untampered chain', () => {
    assert.deepEqual(verifyChain(buildChain(specs)), { ok: true });
});

test('verifyChain accepts an empty ledger', () => {
    assert.deepEqual(verifyChain([]), { ok: true });
});

test('verifyChain detects a tampered amount', () => {
    const rows = buildChain(specs);
    rows[1].amount = '999999';
    const v = verifyChain(rows);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAtId, 2);
    assert.equal(v.reason, 'entry_hash mismatch');
});

test('verifyChain detects a deleted middle entry', () => {
    const rows = buildChain(specs);
    rows.splice(1, 1); // removing an entry breaks the prev_hash link
    const v = verifyChain(rows);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAtId, 3);
    assert.equal(v.reason, 'prev_hash mismatch');
});

test('verifyChain detects a re-pointed prev_hash', () => {
    const rows = buildChain(specs);
    rows[2].prev_hash = GENESIS_HASH;
    const v = verifyChain(rows);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAtId, 3);
    assert.equal(v.reason, 'prev_hash mismatch');
});
