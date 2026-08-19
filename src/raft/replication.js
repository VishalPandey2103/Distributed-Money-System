import { pool, withTx } from '../config/db.js';
import * as raftModel from '../models/raftModel.js';
import { nodeConfig } from '../config/nodeConfig.js';
import { callUnary } from './rpc.js';

// Replication module. Three responsibilities:
//   1. Leader periodically sends AppendEntries to every follower
//      (empty = heartbeat, non-empty = log entries to replicate).
//   2. Follower handles incoming AppendEntries: validates prev log,
//      truncates conflicting entries, appends new ones, advances
//      commit index if leader's commit is ahead.
//   3. Leader advances its own commitIndex when a log entry from
//      the CURRENT term is stored on a majority of servers
//      (paper §5.4.2 — critical safety rule).

// ---------------- Leader sends AppendEntries ----------------

export async function sendAppendEntriesToAllPeers(node) {
    if (node.state !== 'LEADER') return;
    await Promise.all(node.peers.map((peer) => sendAppendEntriesToPeer(node, peer)));
}

async function sendAppendEntriesToPeer(node, peer) {
    if (node.state !== 'LEADER') return;

    const nextIndex = node.nextIndex.get(peer.id) ?? 1n;
    const prevLogIndex = nextIndex - 1n;

    let prevLogTerm = 0n;
    if (prevLogIndex > 0n) {
        const prev = await node.log_.getAt(prevLogIndex);
        if (!prev) {
            // Log was somehow truncated below what we thought — reset
            // and try again next tick.
            node.nextIndex.set(peer.id, 1n);
            return;
        }
        prevLogTerm = prev.term;
    }

    const entries = await node.log_.getFrom(nextIndex, nodeConfig.maxBatch);
    const wireEntries = entries.map((e) => ({
        index: e.index.toString(),
        term: e.term.toString(),
        entryType: e.entryType,
        commandJson: e.command === null ? '' : JSON.stringify(e.command),
    }));

    const req = {
        term: node.currentTerm.toString(),
        leaderId: node.id,
        prevLogIndex: prevLogIndex.toString(),
        prevLogTerm: prevLogTerm.toString(),
        entries: wireEntries,
        leaderCommit: node.commitIndex.toString(),
    };

    let res;
    try {
        res = await callUnary(peer.client, 'AppendEntries', req, nodeConfig.heartbeatMs * 4);
    } catch (err) {
        node.log.debug({ peer: peer.id, err: err.message }, 'AppendEntries failed');
        return;
    }

    const respTerm = BigInt(res.term);
    if (respTerm > node.currentTerm) {
        await node.stepDown(respTerm);
        return;
    }
    if (node.state !== 'LEADER' || node.currentTerm !== BigInt(req.term)) return;

    if (res.success) {
        const lastSent = entries.length > 0 ? entries[entries.length - 1].index : prevLogIndex;
        node.nextIndex.set(peer.id, lastSent + 1n);
        node.matchIndex.set(peer.id, lastSent);
        await maybeAdvanceCommitIndex(node);
    } else {
        // Use the follower's conflict-index hint to jump back faster.
        const conflictIndex = BigInt(res.conflictIndex || '0');
        if (conflictIndex > 0n) {
            node.nextIndex.set(peer.id, conflictIndex);
        } else {
            const cur = node.nextIndex.get(peer.id) ?? 1n;
            node.nextIndex.set(peer.id, cur > 1n ? cur - 1n : 1n);
        }
    }
}

// Paper §5.4.2: leader advances commitIndex ONLY for entries in its
// current term (never blindly for entries inherited from a previous
// term). This closes the Figure 8 corner case.
async function maybeAdvanceCommitIndex(node) {
    const { index: lastLogIndex } = await node.log_.getLast();

    for (let n = lastLogIndex; n > node.commitIndex; n -= 1n) {
        const entry = await node.log_.getAt(n);
        if (!entry) continue;
        if (entry.term !== node.currentTerm) continue; // §5.4.2

        // Count self + peers with matchIndex >= n.
        let replicas = 1;
        for (const peer of node.peers) {
            const mi = node.matchIndex.get(peer.id) ?? 0n;
            if (mi >= n) replicas += 1;
        }
        if (replicas >= nodeConfig.quorum) {
            node.commitIndex = n;
            node.applyReady();
            break;
        }
    }
}

// ---------------- Follower handles AppendEntries ----------------

export async function handleAppendEntries(node, req) {
    const term = BigInt(req.term);

    // Reply false if term < currentTerm.
    if (term < node.currentTerm) {
        return {
            term: node.currentTerm.toString(),
            success: false,
            conflictIndex: '0',
            conflictTerm: '0',
        };
    }

    // If leader's term is newer (or equal-and-we're-candidate), step down.
    if (term > node.currentTerm || node.state === 'CANDIDATE') {
        await node.stepDown(term);
    }
    node.leaderId = req.leaderId;
    node.resetElectionTimer();

    const prevLogIndex = BigInt(req.prevLogIndex);
    const prevLogTerm = BigInt(req.prevLogTerm);

    // Consistency check: our log must have an entry at prevLogIndex
    // with matching term.
    if (prevLogIndex > 0n) {
        const ourPrev = await node.log_.getAt(prevLogIndex);
        if (!ourPrev) {
            // We're missing entries — hint leader to jump to our last+1.
            const { index: ourLast } = await node.log_.getLast();
            return {
                term: node.currentTerm.toString(),
                success: false,
                conflictIndex: (ourLast + 1n).toString(),
                conflictTerm: '0',
            };
        }
        if (ourPrev.term !== prevLogTerm) {
            // Term conflict at prevLogIndex — find first index of
            // the conflicting term to help leader rewind quickly.
            const firstIdx = await node.log_.firstIndexInTerm(pool, ourPrev.term);
            return {
                term: node.currentTerm.toString(),
                success: false,
                conflictIndex: (firstIdx ?? prevLogIndex).toString(),
                conflictTerm: ourPrev.term.toString(),
            };
        }
    }

    // Append new entries, truncating any conflict. Do this in a
    // single Postgres transaction so a crash mid-append doesn't
    // leave the log inconsistent.
    if (req.entries && req.entries.length > 0) {
        await withTx(async (client) => {
            for (const wireE of req.entries) {
                const idx = BigInt(wireE.index);
                const t = BigInt(wireE.term);
                const existing = await raftModel.logEntryAt(client, idx);
                if (existing) {
                    if (existing.term === t) continue; // already have it
                    // Conflict — truncate this and everything after.
                    await raftModel.truncateFrom(client, idx);
                }
                await raftModel.appendEntry(client, {
                    index: idx,
                    term: t,
                    entryType: wireE.entryType,
                    command: wireE.commandJson ? JSON.parse(wireE.commandJson) : null,
                });
            }
        });
    }

    // Advance commit index if leader is ahead of us.
    const leaderCommit = BigInt(req.leaderCommit);
    if (leaderCommit > node.commitIndex) {
        const { index: lastLogIndex } = await node.log_.getLast();
        node.commitIndex = leaderCommit < lastLogIndex ? leaderCommit : lastLogIndex;
        node.applyReady();
    }

    return {
        term: node.currentTerm.toString(),
        success: true,
        conflictIndex: '0',
        conflictTerm: '0',
    };
}
