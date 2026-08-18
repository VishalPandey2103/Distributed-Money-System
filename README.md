# Distributed Money System

Distributed Money System — a mini payments backend (like a simplified UPI or Paytm wallet) that transfers money between user accounts across 3 servers.

## Design notes

- Amounts are **BigInt paise** (1 INR = 100 paise) end to end. No floats, no `Number`.
- Postgres `NUMERIC(20,0)` is read as a string and converted at the service boundary.
- Every transfer appends to an **append-only ledger** secured by a SHA-256 hash chain.
- Postgres is the source of truth; Redis is only an idempotency fast path.
- Transfers are idempotent per `txnId` — replaying one returns the original response.

## Setup

Requires Node 20+ and Docker.

```bash
cp .env.example .env
docker compose up -d        # postgres on 5432, redis on 6379
npm install
npm run migrate
npm run dev                 # http://localhost:3000
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run with `--watch` and pretty logs |
| `npm start` | Run the server |
| `npm run migrate` | Apply SQL migrations |
| `npm test` | Run the test suite (serial) |

## API

Health check:

```bash
curl http://localhost:3000/health
```

Create an account (opening balance in paise — 1000_00 = ₹1000):

```bash
curl -X POST http://localhost:3000/api/accounts \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"alice","openingBalancePaise":"100000"}'
```

Fetch an account:

```bash
curl http://localhost:3000/api/accounts/alice
```

Transfer money. `txnId` is the idempotency key — replaying the same one is safe:

```bash
curl -X POST http://localhost:3000/api/transfer \
  -H 'Content-Type: application/json' \
  -d '{"txnId":"txn-001","from":"alice","to":"bob","amountPaise":"25000"}'
```

Verify the whole hash chain:

```bash
curl http://localhost:3000/api/verify
```

## Tests

Bring up Postgres and Redis, run the migrations, then:

```bash
npm test
```

Covers hash chaining, idempotent replay, insufficient balance, same-account
rejection, chain verification, and 20 parallel transfers for deadlock and
money-conservation checks.
