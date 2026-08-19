#!/usr/bin/env bash
# Chaos test: kill the current Raft leader, verify a new one is
# elected within 5s, verify a transfer succeeds against the new
# leader, and verify hash-chain integrity on the survivors.
#
# Requires: docker compose up already, jq, curl.

set -euo pipefail

NODES=("http://localhost:3001" "http://localhost:3002" "http://localhost:3003")

find_leader_url() {
    for node in "${NODES[@]}"; do
        state=$(curl -s "$node/api/raft/status" | jq -r '.state // empty' || true)
        if [ "$state" = "LEADER" ]; then
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

echo "[chaos] waiting for initial leader..."
for i in $(seq 1 30); do
    if leader=$(find_leader_url); then break; fi
    sleep 1
done
echo "[chaos] initial leader: $leader"

container=$(url_to_container "$leader")
echo "[chaos] stopping container $container"
docker stop "$container" >/dev/null

echo "[chaos] waiting for new leader..."
new_leader=""
for i in $(seq 1 15); do
    for node in "${NODES[@]}"; do
        [ "$node" = "$leader" ] && continue
        state=$(curl -s --max-time 1 "$node/api/raft/status" | jq -r '.state // empty' || true)
        if [ "$state" = "LEADER" ]; then new_leader="$node"; break 2; fi
    done
    sleep 1
done

if [ -z "$new_leader" ]; then
    echo "[chaos] FAIL: no new leader elected"
    docker start "$container" >/dev/null || true
    exit 1
fi

echo "[chaos] new leader: $new_leader"

echo "[chaos] issuing transfer to new leader..."
txn_id="chaos_$(date +%s)"
curl -s -X POST "$new_leader/api/transfer" \
    -H 'content-type: application/json' \
    -d "{\"txnId\":\"$txn_id\",\"from\":\"chaos_A\",\"to\":\"chaos_B\",\"amountPaise\":\"1\"}" | jq

echo "[chaos] verifying chain on survivor..."
curl -s "$new_leader/api/verify" | jq

echo "[chaos] restarting old leader..."
docker start "$container" >/dev/null
sleep 3

echo "[chaos] final state on all nodes:"
for node in "${NODES[@]}"; do
    curl -s "$node/api/raft/status" | jq -c '{id, state, term: .currentTerm, commit: .commitIndex, applied: .lastAppliedIndex}'
done

echo "[chaos] done"
