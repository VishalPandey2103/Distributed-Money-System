import { withTx, pool } from '../config/db.js';
import * as raftModel from '../models/raftModel.js';
import { nodeConfig } from '../config/nodeConfig.js';
import { callUnary } from './rpc.js';

// Election module. Two responsibilities:
//   1. Run a randomized election timer. If no valid AppendEntries
//      arrives within the timeout, transition CANDIDATE and start
//      a new election.
//   2. Handle incoming RequestVote RPCs and reply per Figure 2.
//
// Kept as a plain object with functions that take the raft node.
// The node object holds mutable state (state, currentTerm, votedFor,
// leaderId). Election module reads/writes those fields directly —
// this is a deliberate simplification for a placement project.

export function randomizedElectionTimeout() {
    const { electionMinMs, electionMaxMs } = nodeConfig;
    return electionMinMs + Math.floor(Math.random() * (electionMaxMs - electionMinMs));
}

// Called by the raft node on every tick.
export function shouldStartElection(node, now) {
    if (node.state === 'LEADER') return false;
    return now - node.lastHeartbeatFromLeaderMs >= node.electionTimeoutMs;
}

export async function startElection(node) {
    node.log.info({ term: (node.currentTerm + 1n).toString() }, 'starting election');

    // Persist the term bump + self-vote atomically BEFORE any RPC.
    // Figure 2: "Before responding to RPCs, ensure current_term and
    // voted_for are persisted." Same rule applies to becoming a
    // candidate.
    const newTerm = node.currentTerm + 1n;
    await raftModel.setTermAndVote(pool, {
        currentTerm: newTerm,
        votedFor: node.id,
    });
    node.currentTerm = newTerm;
    node.votedFor = node.id;
    node.state = 'CANDIDATE';
    node.leaderId = null;
    node.resetElectionTimer();

    const { index: lastLogIndex, term: lastLogTerm } = await node.log_.getLast();

    let votes = 1; // self
    const req = {
        term: node.currentTerm.toString(),
        candidateId: node.id,
        lastLogIndex: lastLogIndex.toString(),
        lastLogTerm: lastLogTerm.toString(),
    };

    // Fire off RequestVote to every peer in parallel. Any reply that
    // shows a higher term forces us back to follower.
    await Promise.all(
        node.peers.map(async (peer) => {
            try {
                const res = await callUnary(peer.client, 'RequestVote', req, node.electionTimeoutMs);
                const respTerm = BigInt(res.term);
                if (respTerm > node.currentTerm) {
                    await node.stepDown(respTerm);
                    return;
                }
                if (node.state !== 'CANDIDATE' || node.currentTerm !== BigInt(req.term)) {
                    // We moved on (stepped down or newer election).
                    return;
                }
                if (res.voteGranted) {
                    votes += 1;
                    if (votes >= nodeConfig.quorum && node.state === 'CANDIDATE') {
                        await node.becomeLeader();
                    }
                }
            } catch (err) {
                // Peer unreachable — just don't count the vote.
                node.log.debug({ peer: peer.id, err: err.message }, 'RequestVote failed');
            }
        })
    );
}

// Handle an incoming RequestVote (called from grpc server handler).
export async function handleRequestVote(node, req) {
    const term = BigInt(req.term);
    const candidateLastIndex = BigInt(req.lastLogIndex);
    const candidateLastTerm = BigInt(req.lastLogTerm);

    // Rule 1: reply false if term < currentTerm.
    if (term < node.currentTerm) {
        return { term: node.currentTerm.toString(), voteGranted: false };
    }

    // If RPC term is newer, step down first. This may clear votedFor.
    if (term > node.currentTerm) {
        await node.stepDown(term);
    }

    // Rule 2: grant vote iff we haven't voted this term (or already
    // voted for this candidate) AND candidate's log is at least as
    // up-to-date as ours.
    const { index: ourLastIndex, term: ourLastTerm } = await node.log_.getLast();
    const upToDate =
        candidateLastTerm > ourLastTerm ||
        (candidateLastTerm === ourLastTerm && candidateLastIndex >= ourLastIndex);

    const canVote = node.votedFor === null || node.votedFor === req.candidateId;

    if (canVote && upToDate) {
        await raftModel.setTermAndVote(pool, {
            currentTerm: node.currentTerm,
            votedFor: req.candidateId,
        });
        node.votedFor = req.candidateId;
        node.resetElectionTimer(); // granting a vote resets our timer
        return { term: node.currentTerm.toString(), voteGranted: true };
    }
    return { term: node.currentTerm.toString(), voteGranted: false };
}
