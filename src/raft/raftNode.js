import pino from 'pino';
import { EventEmitter } from 'node:events';
import { pool, withTx } from '../config/db.js';
import * as raftModel from '../models/raftModel.js';
import { nodeConfig } from '../config/nodeConfig.js';
import { makePeerClient, startGrpcServer } from './rpc.js';
import * as raftLog from './raftLog.js';
import {
    startElection,
    handleRequestVote,
    randomizedElectionTimeout,
    shouldStartElection,
} from './election.js';
import {
    sendAppendEntriesToAllPeers,
    handleAppendEntries,
} from './replication.js';

// The raft node. Owns all mutable state and drives the two timers:
//   - electionTimer: fires when no valid leader traffic within a randomized window
//   - heartbeatTimer: leader-only, fires every heartbeatMs
//
// Applies committed entries by calling out to a state machine that
// this module receives at construction. The state machine is
// responsible for the actual domain work (transfers).

export class RaftNode extends EventEmitter {
    constructor({ stateMachine }) {
        super();
        this.log = pino({ name: `raft:${nodeConfig.me.id}`, level: process.env.LOG_LEVEL || 'info' });
        this.id = nodeConfig.me.id;
        this.stateMachine = stateMachine;
        this.log_ = raftLog;

        this.state = 'FOLLOWER';
        this.currentTerm = 0n;
        this.votedFor = null;
        this.leaderId = null;
        this.commitIndex = 0n;
        this.lastAppliedIndex = 0n;

        this.nextIndex = new Map();   // peerId -> BigInt
        this.matchIndex = new Map();  // peerId -> BigInt

        this.peers = nodeConfig.peers.map((p) => ({
            id: p.id,
            grpcAddr: p.grpcAddr,
            httpBase: p.httpBase,
            client: makePeerClient(p.grpcAddr),
        }));

        this.electionTimeoutMs = randomizedElectionTimeout();
        this.lastHeartbeatFromLeaderMs = Date.now();

        this.electionInterval = null;
        this.heartbeatInterval = null;
        this.applyLoopRunning = false;
        this.applyWaiters = new Map();  // logIndex -> { resolve, reject }
        this.grpcServer = null;
    }

    async start() {
        // Load persisted term/vote/last-applied.
        const meta = await raftModel.loadMeta(pool);
        this.currentTerm = meta.currentTerm;
        this.votedFor = meta.votedFor;
        this.lastAppliedIndex = meta.lastAppliedIndex;
        // commitIndex is volatile per Raft — start it at last-applied
        // (safe: everything already applied was, by construction,
        // committed). On first heartbeat from a leader it will advance.
        this.commitIndex = this.lastAppliedIndex;

        this.log.info(
            {
                term: this.currentTerm.toString(),
                votedFor: this.votedFor,
                lastApplied: this.lastAppliedIndex.toString(),
            },
            'raft node starting'
        );

        // Bring up gRPC server.
        const { server } = await startGrpcServer({
            port: nodeConfig.grpcPort,
            handlers: {
                requestVote:   (req) => handleRequestVote(this, req),
                appendEntries: (req) => handleAppendEntries(this, req),
            },
        });
        this.grpcServer = server;
        this.log.info({ port: nodeConfig.grpcPort }, 'grpc server listening');

        // Election tick. 50ms granularity is plenty given election
        // timeouts are 800-1500ms.
        this.electionInterval = setInterval(() => {
            if (shouldStartElection(this, Date.now())) {
                startElection(this).catch((err) =>
                    this.log.error({ err }, 'election failed')
                );
            }
        }, 50);
    }

    resetElectionTimer() {
        this.lastHeartbeatFromLeaderMs = Date.now();
        this.electionTimeoutMs = randomizedElectionTimeout();
    }

    // Called by election.js on vote success.
    async becomeLeader() {
        this.state = 'LEADER';
        this.leaderId = this.id;
        this.log.info({ term: this.currentTerm.toString() }, 'became leader');

        const { index: lastLogIndex } = await this.log_.getLast();
        for (const peer of this.peers) {
            this.nextIndex.set(peer.id, lastLogIndex + 1n);
            this.matchIndex.set(peer.id, 0n);
        }

        // Append a no-op in our new term (paper §8) so we can advance
        // commitIndex quickly and clients see a stable leader.
        await raftLog.append(pool, {
            index: lastLogIndex + 1n,
            term: this.currentTerm,
            entryType: 'noop',
            command: null,
        });

        // Fire heartbeats immediately and on interval.
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            sendAppendEntriesToAllPeers(this).catch((err) =>
                this.log.error({ err }, 'heartbeat failed')
            );
        }, nodeConfig.heartbeatMs);
        sendAppendEntriesToAllPeers(this).catch(() => {});
    }

    // Called from anywhere on discovery of a higher term.
    async stepDown(newTerm) {
        const wasLeader = this.state === 'LEADER';
        this.state = 'FOLLOWER';
        if (newTerm > this.currentTerm) {
            this.currentTerm = newTerm;
            this.votedFor = null;
            await raftModel.setTermAndVote(pool, {
                currentTerm: newTerm,
                votedFor: null,
            });
        }
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        this.resetElectionTimer();
        if (wasLeader) {
            this.log.info({ term: newTerm.toString() }, 'stepped down');
            // Reject any pending proposals — client should retry.
            for (const [idx, waiter] of this.applyWaiters) {
                waiter.reject(new Error('LEADER_STEP_DOWN'));
                this.applyWaiters.delete(idx);
            }
        }
    }

    // ---------------- Client proposals (leader only) ----------------

    async propose(command) {
        if (this.state !== 'LEADER') {
            const leader = this.leaderId
                ? this.peers.find((p) => p.id === this.leaderId) || (this.leaderId === this.id ? nodeConfig.me : null)
                : null;
            const leaderHttp = leader?.httpBase || null;
            const err = new Error('NOT_LEADER');
            err.code = 'NOT_LEADER';
            err.leaderId = this.leaderId;
            err.leaderHttp = leaderHttp;
            throw err;
        }

        const { index: lastLogIndex } = await raftLog.getLast();
        const newIndex = lastLogIndex + 1n;

        await raftLog.append(pool, {
            index: newIndex,
            term: this.currentTerm,
            entryType: 'command',
            command,
        });

        // Wait for the state machine to apply this index. If we step
        // down before that happens, the waiter is rejected.
        const applied = await new Promise((resolve, reject) => {
            this.applyWaiters.set(newIndex, { resolve, reject });
            // Kick replication immediately instead of waiting for the
            // next heartbeat tick — cuts p50 latency by half a tick.
            sendAppendEntriesToAllPeers(this).catch(() => {});
        });

        return { logIndex: newIndex, applied };
    }

    // Called by replication.js after commitIndex advances.
    applyReady() {
        if (this.applyLoopRunning) return;
        this.applyLoopRunning = true;
        this.applyLoop().catch((err) => {
            this.log.error({ err }, 'apply loop crashed');
            this.applyLoopRunning = false;
        });
    }

    async applyLoop() {
        while (this.lastAppliedIndex < this.commitIndex) {
            const nextIdx = this.lastAppliedIndex + 1n;
            const entry = await raftLog.getAt(nextIdx);
            if (!entry) {
                // Shouldn't happen — commitIndex says it's committed,
                // so the entry must be on our log. Bail loudly.
                this.log.error({ nextIdx: nextIdx.toString() }, 'missing entry at commit');
                break;
            }

            let appliedResult;
            if (entry.entryType === 'noop') {
                appliedResult = { ok: true, noop: true };
                // Persist last_applied in the same txn to avoid replay.
                await withTx(async (client) => {
                    await raftModel.setLastAppliedIndex(client, nextIdx);
                });
            } else {
                // Delegate to state machine. It runs its work + updates
                // last_applied atomically inside one transaction.
                appliedResult = await this.stateMachine.apply(entry.command, nextIdx);
            }

            this.lastAppliedIndex = nextIdx;
            const waiter = this.applyWaiters.get(nextIdx);
            if (waiter) {
                waiter.resolve(appliedResult);
                this.applyWaiters.delete(nextIdx);
            }
        }
        this.applyLoopRunning = false;
    }

    async shutdown() {
        if (this.electionInterval) clearInterval(this.electionInterval);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.grpcServer) {
            await new Promise((r) => this.grpcServer.tryShutdown(() => r()));
        }
        for (const peer of this.peers) peer.client.close();
    }
}

// Singleton accessor used from HTTP handlers.
let instance = null;
export function setRaftNode(n) { instance = n; }
export function getRaftNode() { return instance; }
