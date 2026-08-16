import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

async function main() {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
        const { rows } = await client.query(
            `SELECT 1 FROM schema_migrations WHERE name = $1`,
            [file]
        );
        if (rows.length > 0) {
            console.log(`skip  ${file}`);
            continue;
        }
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        console.log(`apply ${file}`);
        await client.query('BEGIN');
        try {
            await client.query(sql);
            await client.query(
                `INSERT INTO schema_migrations (name) VALUES ($1)`,
                [file]
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`failed ${file}:`, err.message);
            throw err;
        }
    }

    await client.end();
    console.log('migrations done');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
