/**
 * Additive-only migration runner.
 *
 * Usage:
 *   node migrations/run.js            Apply all pending migrations.
 *   node migrations/run.js --status   List applied / pending migrations only.
 *
 * Safety:
 *   - Refuses to run against NODE_ENV=production unless BACKUP_CONFIRMED=true
 *     is set, so a production run always requires a deliberate, explicit
 *     acknowledgement that a backup was taken first. See migrations/README.md
 *     for the exact backup command.
 *   - Each migration file runs inside its own transaction and is recorded in
 *     schema_migrations only on success, so a failed migration can be fixed
 *     and re-run safely (already-applied files are skipped).
 */
const { loadEnv, assertNotRemoteDatabase } = require('../lib/env-guard');
loadEnv();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { databaseSslConfig } = require('../lib/db-ssl');

const MIGRATIONS_DIR = __dirname;
const isProduction = process.env.NODE_ENV === 'production';
const statusOnly = process.argv.includes('--status');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set.');
    process.exit(1);
  }
  try {
    assertNotRemoteDatabase(process.env.DATABASE_URL);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
  if (isProduction && !statusOnly && process.env.BACKUP_CONFIRMED !== 'true') {
    console.error('❌ Refusing to run migrations against NODE_ENV=production.');
    console.error('   Take a backup first, then re-run with BACKUP_CONFIRMED=true.');
    console.error('   Backup command: pg_dump "$DATABASE_URL" -F c -f backup_$(date +%Y%m%d%H%M%S).dump');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: databaseSslConfig() });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: appliedRows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.filename));
  const pending = files.filter((f) => !applied.has(f));

  if (statusOnly) {
    console.log('Applied:');
    files.filter((f) => applied.has(f)).forEach((f) => console.log(`  ✅ ${f}`));
    console.log('Pending:');
    pending.forEach((f) => console.log(`  ⏳ ${f}`));
    await pool.end();
    return;
  }

  if (!pending.length) {
    console.log('✅ No pending migrations.');
    await pool.end();
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✅ Applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`❌ Failed applying ${file}: ${err.message}`);
      await pool.end();
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('✅ All migrations applied.');
}

main().catch((err) => {
  console.error('❌ Migration runner error:', err.message);
  process.exit(1);
});
