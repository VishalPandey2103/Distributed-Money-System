import 'dotenv/config';
import express from 'express';
import pinoHttp from 'pino-http';
import pino from 'pino';

import accountRoutes from './routes/accountRoutes.js';
import transferRoutes from './routes/transferRoutes.js';
import raftRoutes from './routes/raftRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { shutdownDb } from './config/db.js';
import { shutdownRedis } from './config/redis.js';
import { nodeConfig } from './config/nodeConfig.js';
import { RaftNode, setRaftNode } from './raft/raftNode.js';
import { stateMachine } from './services/stateMachine.js';

const log = pino({ name: 'server', level: process.env.LOG_LEVEL || 'info' });
const app = express();

app.use(express.json({ limit: '64kb' }));
app.use(pinoHttp({ logger: log }));

app.get('/health', (_req, res) => res.json({ ok: true, nodeId: nodeConfig.me.id }));

app.use('/api', accountRoutes);
app.use('/api', transferRoutes);
app.use('/api', raftRoutes);

app.use(errorHandler);

const raft = new RaftNode({ stateMachine });
setRaftNode(raft);

const PORT = nodeConfig.httpPort;
const server = app.listen(PORT, async () => {
    log.info({ port: PORT, nodeId: nodeConfig.me.id }, 'ledger http listening');
    try {
        await raft.start();
    } catch (err) {
        log.error({ err }, 'raft failed to start');
        process.exit(1);
    }
});

async function shutdown(signal) {
    log.info({ signal }, 'shutting down');
    server.close(() => log.info('http closed'));
    await raft.shutdown().catch(() => {});
    await shutdownRedis().catch(() => {});
    await shutdownDb().catch(() => {});
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
