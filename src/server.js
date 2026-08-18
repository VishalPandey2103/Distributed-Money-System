import 'dotenv/config';
import express from 'express';
import pinoHttp from 'pino-http';
import pino from 'pino';

import accountRoutes from './routes/accountRoutes.js';
import transferRoutes from './routes/transferRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { shutdownDb } from './config/db.js';
import { shutdownRedis } from './config/redis.js';

const log = pino({ name: 'server', level: process.env.LOG_LEVEL || 'info' });
const app = express();

app.use(express.json({ limit: '64kb' }));
app.use(pinoHttp({ logger: log }));

app.get('/health', (_req, res) => res.json({ ok: true, nodeId: process.env.NODE_ID || 'node-1' }));

app.use('/api', accountRoutes);
app.use('/api', transferRoutes);

app.use(errorHandler);

const PORT = Number(process.env.PORT || 3000);
const server = app.listen(PORT, () => {
    log.info({ port: PORT }, 'ledger listening');
});

async function shutdown(signal) {
    log.info({ signal }, 'shutting down');
    server.close(() => log.info('http closed'));
    await shutdownRedis().catch(() => {});
    await shutdownDb().catch(() => {});
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
