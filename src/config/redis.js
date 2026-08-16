import 'dotenv/config';
import Redis from 'ioredis';
import pino from 'pino';

const log = pino({ name: 'redis', level: process.env.LOG_LEVEL || 'info' });

export const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
});

redis.on('error', (err) => log.warn({ err: err.message }, 'redis error'));
redis.on('ready', () => log.info('redis ready'));

export async function shutdownRedis() {
    await redis.quit();
}
