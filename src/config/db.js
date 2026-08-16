import 'dotenv/config';
import pg from 'pg';
import pino from 'pino';

const log = pino({ name: 'db', level: process.env.LOG_LEVEL || 'info' });

// Parse NUMERIC into a JS number so balances come back as numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PGPOOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS || 30000),
    application_name: `ledger-${process.env.NODE_ID || 'node-1'}`,
});

pool.on('error', (err) => {
    log.error({ err }, 'idle pg client error');
});

export async function withTx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function shutdownDb() {
    await pool.end();
}
