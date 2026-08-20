# Ledger — v2 (3-Node Raft)

Distributed replicated ledger. 3 nodes, each with own Postgres + Redis. Consensus via minimal Raft implemented from scratch: leader election, log replication, safety (Figure 8 rule), persistent term/vote/log, exactly-once apply to state machine.

## What's new vs v1

- Custom Raft (election.js, replication.js, raftNode.js, raftLog.js, rpc.js)
- gRPC RPCs (RequestVote, AppendEntries) via @grpc/grpc-js
- Deterministic state machine (`services/stateMachine.js`)
- `transfer()` calls `raft.propose()` — only the leader accepts writes; followers return 421 with the leader's HTTP address
- Per-node Postgres and Redis in docker-compose
- Chaos test: kill leader, verify re-election + zero data loss

## Cluster topology

| Node   | HTTP  | gRPC | Postgres | Redis |
|--------|-------|------|----------|-------|
| node-1 | 3001  | 6001 | 5433     | 6390  |
| node-2 | 3002  | 6002 | 5434     | 6391  |
| node-3 | 3003  | 6003 | 5435     | 6392  |

## Prerequisites

- Docker (with Compose v2) — runs the whole 3-node stack
- Node.js >= 20 — only needed to run the test suite from the host
- `curl` — for the verification snippets below

`jq` is optional; it only pretty-prints the `curl` output in this
README. Nothing in the project requires it.

## Run

```bash
docker compose build
docker compose up -d
docker compose logs -f node1     # watch a node
```

Migrations run automatically on container startup (see Dockerfile CMD).
A leader is normally elected within ~2s of `up`; until then every node
reports `FOLLOWER` and writes return 421.

Tear down with `docker compose down`, or `docker compose down -v` to
also drop the three Postgres volumes and start from an empty ledger.

## Verify the cluster

```bash
# Which node is the leader?
for p in 3001 3002 3003; do
  curl -s http://localhost:$p/api/raft/status | jq -c '{id, state, term: .currentTerm}'
done

# Create the same accounts on all nodes (v2 does not raft-replicate
# account creation — see design note in ledgerService.js).
for p in 3001 3002 3003; do
  curl -s -X POST http://localhost:$p/api/accounts \
    -H 'content-type: application/json' \
    -d '{"accountId":"alice","openingBalancePaise":"100000"}'
  curl -s -X POST http://localhost:$p/api/accounts \
    -H 'content-type: application/json' \
    -d '{"accountId":"bob","openingBalancePaise":"0"}'
done

# Transfer — hit any node; followers redirect via 421 + leaderHttp
curl -si -X POST http://localhost:3002/api/transfer \
  -H 'content-type: application/json' \
  -d '{"txnId":"t-1","from":"alice","to":"bob","amountPaise":"25000"}'

# If you got 421, follow the "leaderHttp" field in the response.

# After ~1 second (heartbeat + apply), read from ALL nodes and see
# identical balances:
for p in 3001 3002 3003; do
  echo "== node on :$p =="
  curl -s http://localhost:$p/api/accounts/alice | jq
  curl -s http://localhost:$p/api/accounts/bob   | jq
done

# Verify the hash chain on every node
for p in 3001 3002 3003; do
  curl -s http://localhost:$p/api/verify | jq
done
```

## Chaos test

```bash
npm run chaos       # or: bash tests/chaos/leader-kill.sh
```

Seeds `chaos_A`/`chaos_B` on every node, kills the current leader,
waits for re-election on the surviving majority, issues a transfer
against the new leader, verifies the chain, restarts the killed node,
and checks that the rejoined node converges on the same balance.
Exits non-zero if re-election, the write, or the chain check fails.

## Tests

```bash
npm install
npm test            # unit + cluster (needs the stack up)
npm run test:unit   # money + hash chain only, no stack needed
npm run test:cluster
```

`test:unit` covers the deterministic core — paise parsing and the
hash chain — and needs no Postgres, Redis, or cluster. The transfer
path is deliberately not unit-tested: in v2 every write goes through
`raft.propose()`, which needs a live quorum, so it is covered
end-to-end by `tests/cluster.test.js` against the running stack.

## Key design decisions

- **Election timing** — 150ms heartbeats, 800–1500ms randomized election timeout. Paper suggests 150–300ms but that's noisy on a laptop with 3 processes.
- **Log storage** — persisted in each node's own Postgres so state-machine apply + `last_applied_index` update happen atomically in one transaction. Exactly-once semantics without a two-phase commit.
- **§5.4.2 safety** — leader only advances commit index for entries in its current term. This closes the Figure 8 corner case where an entry from a previous term appears committed but can be overwritten.
- **Conflict-index optimization** — followers reply with the first index of the conflicting term, so the leader rewinds `nextIndex` in O(1) jumps instead of O(term length).
- **Serialized log appends** — `propose()` reads the log tail and appends at tail+1. Those two steps are held under one lock, because concurrent proposals that both read the same tail would append the same `log_index` and collide on the primary key.
- **Bounded proposals** — a proposal waits `RAFT_PROPOSE_TIMEOUT_MS` (default 5s) to be applied, then returns 503 rather than hanging the request. Retrying with the same `txnId` is safe by construction.
- **No InstallSnapshot in v2** — snapshots are a v3 concern. Log stays bounded enough for placement scope.
- **Account creation not raft-replicated in v2** — deliberate simplification. Balances converge only for txnIds proposed through Raft; accounts are created identically on every node ahead of time. A production system would fold `createAccount` into Raft too — trivial extension, kept out here to isolate the interesting work in the transfer path.

## Interview talking points this covers

- Raft leader election, log matching, safety (§5.4.2)
- Leader-follower replication with majority quorum
- CAP theorem — we chose CP: writes stop on a follower minority partition
- ACID under distribution — Postgres local ACID + Raft global ordering
- Exactly-once apply via `last_applied_index` in same transaction
- Idempotency: Redis fast path + Postgres UNIQUE + state-machine determinism
- Deadlock-free concurrency via sorted `FOR UPDATE` (still holds inside apply)
- Hash-chained WAL for tamper detection
- gRPC bidirectional plumbing with deadlines and back-pressure

## Next (v3)

- k6 load tests targeting 5k–10k TPS with group commit batching
- Prometheus metrics + Grafana dashboard
- InstallSnapshot RPC + log compaction
- Architecture diagrams and demo video
