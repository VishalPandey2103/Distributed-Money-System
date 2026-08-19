import { getRaftNode } from '../raft/raftNode.js';
import { nodeConfig } from '../config/nodeConfig.js';

export async function getStatus(_req, res) {
    const n = getRaftNode();
    if (!n) return res.status(503).json({ error: 'raft not ready' });
    res.json({
        id: n.id,
        state: n.state,
        currentTerm: n.currentTerm.toString(),
        votedFor: n.votedFor,
        leaderId: n.leaderId,
        commitIndex: n.commitIndex.toString(),
        lastAppliedIndex: n.lastAppliedIndex.toString(),
        peers: nodeConfig.peers.map((p) => p.id),
    });
}
