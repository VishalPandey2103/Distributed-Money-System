#!/usr/bin/env bash
# Chaos test: kill the current Raft leader, verify a new one is
# elected within ~15s, verify a transfer succeeds against the new
# leader, and verify hash-chain integrity on the survivors.
#
# Requires: docker compose up already, curl, node.
# (node ships with the project, so we use it instead of jq for JSON.)

set -uo pipefail

NODES=("http://localhost:3001" "http://localhost:3002" "http://localhost:3003")

# --- JSON helpers (node stands in for jq) ---------------------------

# Read stdin as JSON, print a dotted path. Empty string on any failure.
field() {
    node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
            try {
                const v = process.argv[1]
                    .split(".")
                    .reduce((a, k) => (a == null ? a : a[k]), JSON.parse(s));
                process.stdout.write(v == null ? "" : String(v));
            } catch { process.stdout.write(""); }
        });
    ' "$1"
}

# Read stdin as JSON, pretty-print it. Echo raw text if it isn't JSON.
pretty() {
    node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
            try { console.log(JSON.stringify(JSON.parse(s), null, 2)); }
            catch { console.log(s.trim()); }
        });
    '
}

status_of() {
    curl -s --max-time 2 "$1/api/raft/status" 2>/dev/null | field state
}

find_leader_url() {
    for node in "${NODES[@]}"; do
        if [ "$(status_of "$node")" = "LEADER" ]; then
            echo "$node"
            return 0
        fi
    done
    return 1
}

url_to_container() {
    case "$1" in
        *3001) echo "ledger-node1" ;;
        *3002) echo "ledger-node2" ;;
        *3003) echo "ledger-node3" ;;
    esac
}

post_json() {
    curl -s --max-time 5 -X POST "$1" -H 'content-type: application/json' -d "$2"
}

# --- 0. Seed accounts on every node ---------------------------------
# Account creation is not raft-replicated in v2, so each node needs
# its own copy before any transfer can reference them. Re-running is
# harmless: a duplicate returns 409 and we ignore it.

echo "[chaos] seeding chaos_A / chaos_B on all nodes..."
for node in "${NODES[@]}"; do
    post_json "$node/api/accounts" '{"accountId":"chaos_A","openingBalancePaise":"1000000"}' >/dev/null
    post_json "$node/api/accounts" '{"accountId":"chaos_B","openingBalancePaise":"0"}' >/dev/null
done

# --- 1. Find the current leader -------------------------------------

echo "[chaos] waiting for initial leader..."
leader=""
for _ in $(seq 1 30); do
    if leader=$(find_leader_url); then break; fi
    sleep 1
done

if [ -z "$leader" ]; then
    echo "[chaos] FAIL: no initial leader found"
    exit 1
fi
echo "[chaos] initial leader: $leader"

container=$(url_to_container "$leader")

# --- 2. Kill it ------------------------------------------------------

echo "[chaos] stopping container $container"
docker stop "$container" >/dev/null

# Make sure the old leader is restarted even if we bail out early.
trap 'echo "[chaos] restarting $container"; docker start "$container" >/dev/null 2>&1 || true' EXIT

# --- 3. Wait for re-election on the surviving majority ---------------

echo "[chaos] waiting for new leader..."
new_leader=""
for _ in $(seq 1 15); do
    for node in "${NODES[@]}"; do
        [ "$node" = "$leader" ] && continue
        if [ "$(status_of "$node")" = "LEADER" ]; then new_leader="$node"; break 2; fi
    done
    sleep 1
done

if [ -z "$new_leader" ]; then
    echo "[chaos] FAIL: no new leader elected"
    exit 1
fi
echo "[chaos] new leader: $new_leader"

# --- 4. Writes still succeed on the new leader -----------------------

echo "[chaos] issuing transfer to new leader..."
txn_id="chaos_$(date +%s)"
resp=$(post_json "$new_leader/api/transfer" \
    "{\"txnId\":\"$txn_id\",\"from\":\"chaos_A\",\"to\":\"chaos_B\",\"amountPaise\":\"1\"}")
echo "$resp" | pretty

if [ -z "$(echo "$resp" | field entryHash)" ]; then
    echo "[chaos] FAIL: transfer against the new leader did not commit"
    exit 1
fi
echo "[chaos] transfer committed on the new leader"

# --- 5. Chain still verifies -----------------------------------------

echo "[chaos] verifying chain on survivor..."
verify=$(curl -s --max-time 5 "$new_leader/api/verify")
echo "$verify" | pretty
if [ "$(echo "$verify" | field ok)" != "true" ]; then
    echo "[chaos] FAIL: hash chain broken on $new_leader"
    exit 1
fi

# --- 6. Bring the old leader back and let it catch up ----------------

echo "[chaos] restarting old leader..."
trap - EXIT
docker start "$container" >/dev/null
sleep 8

echo "[chaos] final state on all nodes:"
for node in "${NODES[@]}"; do
    s=$(curl -s --max-time 3 "$node/api/raft/status")
    printf '  %-24s state=%-9s term=%-3s commit=%-4s applied=%s\n' \
        "$node" \
        "$(echo "$s" | field state)" \
        "$(echo "$s" | field currentTerm)" \
        "$(echo "$s" | field commitIndex)" \
        "$(echo "$s" | field lastAppliedIndex)"
done

# The rejoined node must converge on the same committed balance.
echo "[chaos] chaos_B balance on every node (must match):"
for node in "${NODES[@]}"; do
    printf '  %-24s %s\n' "$node" \
        "$(curl -s --max-time 3 "$node/api/accounts/chaos_B" | field balancePaise)"
done

echo "[chaos] done"
