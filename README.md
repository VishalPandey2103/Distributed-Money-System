# Distributed Money System

This project is a small three-node money ledger built around a Raft cluster, local Postgres databases, and Redis for idempotency caching. The code is intentionally narrow and easy to trace: the HTTP layer decides whether a request is valid, the Raft layer decides ordering, and the state machine applies the final transfer result locally on each node.

The important part is that there is no shared database behind the replicas. Each node has its own Postgres and Redis, and every replica applies the same committed log entries to its own state.

## Architecture

This is a three-node Raft cluster running as separate Docker services. Each node exposes the same HTTP API, but only the current leader accepts new transfer proposals.

```text
                          ┌──────────────────────────────┐
                          │        Client / API user     │
                          │  POST /api/accounts          │
                          │  POST /api/transfer          │
                          │  GET /api/raft/status       │
                          └──────────────┬───────────────┘
                                         │
                                         │ HTTP
                                         ▼

              ┌────────────────────────────────────────────────────────────┐
              │                        node-1                               │
              │  Express API  ──►  Raft node  ──►  Postgres (pg1)         │
              │                     │      │                                │
              │                     │      └─► raft_meta / raft_log       │
              │                     │                                        │
              │                     └────► Redis (redis1)                   │
              │                          idem:<txnId> fast path             │
              └────────────────────────────────────────────────────────────┘
                                         │
                                         │ gRPC / Raft replication
                                         │
              ┌────────────────────────────────────────────────────────────┐
              │                        node-2                               │
              │  Express API  ──►  Raft node  ──►  Postgres (pg2)         │
              │                     │      │                                │
              │                     │      └─► raft_meta / raft_log       │
              │                     │                                        │
              │                     └────► Redis (redis2)                   │
              └────────────────────────────────────────────────────────────┘
                                         │
                                         │
              ┌────────────────────────────────────────────────────────────┐
              │                        node-3                               │
              │  Express API  ──►  Raft node  ──►  Postgres (pg3)         │
              │                     │      │                                │
              │                     │      └─► raft_meta / raft_log       │
              │                     │                                        │
              │                     └────► Redis (redis3)                   │
              └────────────────────────────────────────────────────────────┘

                 node-1 <-------------------- Raft peer traffic --------------------> node-2
                          \____________________  RequestVote / AppendEntries  ______________/

                 node-2 <-------------------- Raft peer traffic --------------------> node-3
                          \____________________  RequestVote / AppendEntries  ______________/

                 node-1 <-------------------- Raft peer traffic --------------------> node-3
                          \____________________  RequestVote / AppendEntries  ______________/
```

This is the runtime layout the repo actually builds in Docker. Each node owns its own database and cache; the cluster as a whole is defined by the `CLUSTER` environment in [docker-compose.yml](docker-compose.yml).

## What is in this repo

- `src/server.js` starts the Express app and brings up the local Raft node.
- `src/routes/*` exposes the HTTP API.
- `src/controllers/*` validates request payloads and translates domain errors into responses.
- `src/raft/*` contains the election, log replication, and RPC code.
- `src/services/stateMachine.js` is the deterministic apply step that updates balances and ledger entries.
- `src/services/ledgerService.js` handles idempotency and leader checks.
- `src/models/*` and `migrations/*` store raft state, accounts, ledger rows, and idempotency results.
- `tests/cluster.test.js` exercises the running docker-compose cluster.

## How the cluster is laid out

There are three nodes:

- node-1: http://localhost:3001, gRPC 6001, Postgres 5433, Redis 6390
- node-2: http://localhost:3002, gRPC 6002, Postgres 5434, Redis 6391
- node-3: http://localhost:3003, gRPC 6003, Postgres 5435, Redis 6392

Each node runs:

- a local HTTP API
- a local Raft member
- its own Postgres database
- its own Redis instance

The cluster membership is defined in `docker-compose.yml` through `CLUSTER`.

## Real behavior of the system

This is not a generic "banking demo" with hidden magic. The code makes some things explicit:

- Transfers are not accepted by every node. Only the active leader should accept a new transfer proposal.
- If a follower receives a transfer request, it responds with HTTP 421 and includes the leader HTTP address.
- The client is expected to retry against the leader using the same `txnId`.
- A transfer is idempotent by `txnId`. The same transaction ID resolves to the same stored outcome.
- Amounts are stored as integer paise using `BigInt`; decimal values are rejected.
- Account creation is not Raft-replicated. It is intentionally local and must be done on each node before transfers can use those account IDs.
- The state machine records both successful and failed transfers in the local idempotency table so the result is replay-safe.

## Transfer flow, in plain terms

1. Client sends `POST /api/transfer` to any node.
2. The service checks Redis for `idem:<txnId>`.
3. If Redis is empty, it checks the local Postgres `idempotency` table.
4. If the contacted node is not leader, it returns 421 with `leaderHttp` and the client retries there.
5. The leader appends the transfer to the Raft log and replicates it to peers.
6. Once a quorum stores the entry, the leader applies it to its local state machine.
7. The state machine locks the two accounts in deterministic order, updates balances, writes the ledger hash-chained record, stores the idempotency result, and advances the applied index in one transaction.
8. Followers eventually learn the commit index and apply the same command in order.

This is a replicated state machine, not a centrally shared ledger.

## API surface

### Health

`GET /health`

Returns whether the node is up and which node ID it is.

Example:

```bash
curl http://localhost:3001/health
```

### Account creation

`POST /api/accounts`

Body:

```json
{
  "accountId": "alice",
  "openingBalancePaise": "100000"
}
```

The account ID must match the regex used in the validator: alphanumeric, underscore, or hyphen.

Example:

```bash
curl -sS -X POST http://localhost:3001/api/accounts \
  -H 'content-type: application/json' \
  -d '{"accountId":"alice","openingBalancePaise":"100000"}'
```

### Get account

`GET /api/accounts/:accountId`

Example:

```bash
curl http://localhost:3001/api/accounts/alice
```

### Transfer

`POST /api/transfer`

Body:

```json
{
  "txnId": "txn-001",
  "from": "alice",
  "to": "bob",
  "amountPaise": "25000"
}
```

Important details from the code:

- `txnId` is required and limited to `[A-Za-z0-9_-]+`
- `amountPaise` must be positive
- same-account transfer is rejected
- if the account is missing or balance is too low, the outcome is recorded as a committed rejection

Example:

```bash
curl -sS -X POST http://localhost:3001/api/transfer \
  -H 'content-type: application/json' \
  -d '{"txnId":"txn-001","from":"alice","to":"bob","amountPaise":"25000"}'
```

If you hit a follower, you will get a response like:

```json
{
  "error": {
    "code": "NOT_LEADER",
    "message": "NOT_LEADER",
    "leaderId": "node-2",
    "leaderHttp": "http://localhost:3002"
  }
}
```

The client is expected to retry the same request against `leaderHttp`.

### Verify ledger

`GET /api/verify`

This loads the ledger in order and checks the hash chain. It is the direct integrity check for the append-only ledger.

Example:

```bash
curl http://localhost:3001/api/verify
```

### Raft status

`GET /api/raft/status`

This is the status endpoint used by the tests and by operators to find the leader.

Example:

```bash
curl http://localhost:3001/api/raft/status
```

## Running the cluster

### Prerequisites

- Docker with the Compose plugin
- Node.js 20+
- npm

### Start everything

```bash
docker compose up --build -d
```

Check node status:

```bash
docker compose ps
```

The code expects a leader to appear before transfers are sent:

```bash
curl -s http://localhost:3001/api/raft/status
curl -s http://localhost:3002/api/raft/status
curl -s http://localhost:3003/api/raft/status
```

Stop the stack without deleting data:

```bash
docker compose down
```

Remove the named Postgres volumes and reset the ledger state completely:

```bash
docker compose down -v
```

## Things to keep in mind

- Account creation has to be repeated on every node. That is intentional in this version.
- The cluster members do not share a database; they reconcile through Raft.
- Redis is a cache and a fast path; Postgres is the real source of truth for idempotency and state history.
- The hash-chain check is the easiest verification route when you want to confirm the ledger has not been tampered with.

## Tests

This repo has two test groups:

- unit tests for money parsing and ledger hash verification: `npm run test:unit`
- end-to-end cluster tests: `npm run test:cluster`
- both together: `npm test`

The cluster tests assume the docker-compose stack is already running.

Example:

```bash
npm run test:unit
npm run test:cluster
```

## Notes from the implementation

The project is intentionally small and explicit about where the important invariants live:

- `src/raft/raftNode.js` owns the consensus state and apply loop
- `src/services/stateMachine.js` is the exact-once state transition
- `src/services/ledgerService.js` is where the HTTP layer and Raft layer meet
- `src/models/*` and `migrations/*` are where the durable state sits

If you want to understand the behavior, start there rather than reading the README alone.

```

On a freshly initialized cluster, `alice` starts with 1000.00 rupees and `bob` with zero.

### Submit a transfer

You may send a request to any node. If it is not the leader, read `error.leaderHttp` from the `421` response and retry the identical request at that address.

```bash
curl -i -X POST http://localhost:3001/api/transfer \
  -H 'content-type: application/json' \
  -d '{"txnId":"payment_001","from":"alice","to":"bob","amountPaise":"25000"}'
```

A successful first submission returns `201`. Repeating the same `txnId` returns the recorded result with `200` and `cached: true`.

### Read local balances

```bash
curl -s http://localhost:3001/api/accounts/alice
curl -s http://localhost:3002/api/accounts/alice
curl -s http://localhost:3003/api/accounts/alice
```

After a committed transfer, the replicas converge to the same balance. A follower read is local and can briefly lag behind the leader; it is not a linearizable read path.

### Check consensus and ledger integrity

```bash
curl -s http://localhost:3001/api/raft/status
curl -s http://localhost:3001/api/verify
```

`/api/raft/status` reports the node ID, role, current term, known leader, commit index, applied index, and peer IDs. `/api/verify` returns `{ "ok": true }` when the local hash chain is intact.

### Endpoint reference

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/accounts` | Create one local account with an opening balance. |
| `GET` | `/api/accounts/:accountId` | Read one local account balance. |
| `POST` | `/api/transfer` | Propose one replicated transfer to the Raft leader. |
| `GET` | `/api/verify` | Verify the local ledger hash chain. |
| `GET` | `/api/raft/status` | Inspect local Raft state. |
| `GET` | `/health` | Check HTTP process health and node identity. |

### Important HTTP outcomes

| Status | Meaning |
| ---: | --- |
| `201` | A new account or transfer request completed. |
| `200` | A read succeeded, a hash chain is valid, or a transfer retry returned cached data. |
| `400` | Validation failed, amount is invalid, the account pair is invalid, or a committed business rule rejected the transfer. |
| `404` | An account referenced by a read or transfer is absent on that replica. |
| `409` | A local account ID already exists. |
| `421` | The contacted node is not leader. Retry at the returned leader address. |
| `503` | Raft is not ready, the leader changed during the request, or the proposal did not apply before the request timeout. Retry with the same transaction ID. |

## Test and failure exercise

Install host dependencies once:

```bash
npm install
```

Run deterministic unit tests without the cluster:

```bash
npm run test:unit
```

With the Docker stack running, execute the full test set:

```bash
npm test
```

The cluster tests elect a leader, create accounts on every replica, submit a transfer, compare converged balances, replay a transaction ID, and verify each local hash chain.

Run the failure exercise with the stack already running:

```bash
npm run chaos
```

The script seeds `chaos_A` and `chaos_B` on every replica, stops the elected leader, waits for the surviving quorum to elect a replacement, transfers through that replacement, verifies its hash chain, restarts the stopped node, and prints the final replicated state.

## Configuration

Copy `.env.example` when running a node outside Compose. The most important settings are:

| Setting | Used for |
| --- | --- |
| `NODE_ID` | Identifies this application node in cluster membership. |
| `CLUSTER` | Lists every node's ID, gRPC address, and client-visible HTTP address. |
| `HTTP_PORT` and `GRPC_PORT` | Bind the HTTP API and Raft gRPC server. |
| `DATABASE_URL` | Connect to this node's private PostgreSQL instance. |
| `REDIS_URL` | Connect to this node's private idempotency cache. |
| `RAFT_HEARTBEAT_MS` | Controls leader heartbeat frequency. |
| `RAFT_ELECTION_TIMEOUT_MIN_MS` and `RAFT_ELECTION_TIMEOUT_MAX_MS` | Define the randomized election window. |
| `RAFT_MAX_BATCH` | Limits entries included in one replication request. |
| `RAFT_PROPOSE_TIMEOUT_MS` | Bounds how long an HTTP transfer waits for local application. |
| `IDEMPOTENCY_TTL_SECONDS` | Sets the Redis lifetime for cached outcomes. |

All replicas must agree on `CLUSTER`. A node whose ID is absent from that list refuses to start.

## Important operating limits

- Account creation is local, not replicated. Create each account with the same opening balance on every replica before referencing it in a transfer.
- Reads from `/api/accounts/:accountId` are served from the contacted node's database and may be temporarily stale on a follower.
- A three-member cluster needs two available replicas to make progress. Without a quorum, no leader can safely commit new transfers.
- The implementation has no snapshot-install RPC or log compaction. The Raft log therefore grows with the number of proposals.
- gRPC uses insecure transport and Compose publishes service ports to the host. This is suitable for local study; a deployed environment needs network isolation, authenticated client access, and encrypted inter-node transport.
- A `421` response is a retry instruction, not an HTTP redirect. Callers must preserve the original `txnId` when retrying.

## Reading order

For a code walkthrough, start at the entry point and follow a transfer from the edge to durable state:

1. `src/server.js` — process startup, routes, Raft lifecycle, and shutdown.
2. `src/routes/transferRoutes.js` and `src/controllers/transferController.js` — request validation and HTTP responses.
3. `src/services/ledgerService.js` — cache lookup, leader handling, proposal errors, and chain verification.
4. `src/raft/raftNode.js` — proposal serialization, timers, commit application, and singleton access.
5. `src/raft/election.js` and `src/raft/replication.js` — vote rules, heartbeats, log matching, and quorum commit.
6. `src/raft/rpc.js` and `src/proto/raft.proto` — the inter-node wire contract.
7. `src/services/stateMachine.js` — deterministic account and ledger mutation.
8. `src/models/` and `migrations/` — the durable schema and queries behind the above flow.
9. `tests/cluster.test.js` and `tests/chaos/leader-kill.sh` — the expected behavior under replication and leader loss.
