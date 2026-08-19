import 'dotenv/config';

// CLUSTER format:
//   "node-1@grpcHost:grpcPort|httpBase,node-2@..."
// Parse once at boot; consumers read from `peers` and `me`.

function parseCluster(raw) {
    if (!raw) throw new Error('CLUSTER env is required');
    return raw.split(',').map((s) => {
        const [idAndGrpc, httpBase] = s.split('|');
        const [id, grpcAddr] = idAndGrpc.split('@');
        if (!id || !grpcAddr || !httpBase) {
            throw new Error(`bad CLUSTER entry: "${s}"`);
        }
        return { id: id.trim(), grpcAddr: grpcAddr.trim(), httpBase: httpBase.trim() };
    });
}

export const nodeConfig = (() => {
    const nodes = parseCluster(process.env.CLUSTER);
    const myId = process.env.NODE_ID;
    if (!myId) throw new Error('NODE_ID env is required');
    const me = nodes.find((n) => n.id === myId);
    if (!me) throw new Error(`NODE_ID "${myId}" not in CLUSTER`);
    const peers = nodes.filter((n) => n.id !== myId);
    const quorum = Math.floor(nodes.length / 2) + 1;
    return {
        me,
        peers,
        allNodes: nodes,
        quorum,
        httpPort: Number(process.env.HTTP_PORT || 3000),
        grpcPort: Number(process.env.GRPC_PORT || 6000),
        heartbeatMs: Number(process.env.RAFT_HEARTBEAT_MS || 150),
        electionMinMs: Number(process.env.RAFT_ELECTION_TIMEOUT_MIN_MS || 800),
        electionMaxMs: Number(process.env.RAFT_ELECTION_TIMEOUT_MAX_MS || 1500),
        maxBatch: Number(process.env.RAFT_MAX_BATCH || 64),
    };
})();
