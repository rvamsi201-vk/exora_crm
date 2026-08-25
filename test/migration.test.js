/**
 * Runs migrations/001 and the legacy-lead backfill against a throwaway
 * Postgres container — never against a real DATABASE_URL. Skips itself
 * (rather than failing) when Docker isn't available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const CONTAINER = 'exora_migration_test_pg';

function dockerAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitForPg(pool, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Postgres did not become ready in time');
}

test('phase 1 migration + backfill run against a disposable Postgres container', { skip: dockerAvailable() ? false : 'Docker not available' }, async (t) => {
  try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* container may not exist yet */ }
  execSync(
    `docker run --rm -d --name ${CONTAINER} -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 postgres:16-alpine`,
    { stdio: 'ignore' }
  );

  t.after(() => {
    try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* best effort */ }
  });

  const portLine = execSync(`docker port ${CONTAINER} 5432/tcp`).toString().trim();
  const port = portLine.split(':').pop();
  const databaseUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;

  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_SSL_MODE: 'disable',
    NODE_ENV: 'test',
  };

  const pool = new Pool({ connectionString: databaseUrl, ssl: false });
  await waitForPg(pool);

  // Bootstrap the legacy tables Phase 1's migration assumes already exist.
  const legacySql = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_schema.sql'), 'utf8');
  await pool.query(legacySql);

  // Seed one user + two synthetic leads (one with a website, one without).
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ('Test Admin', 'admin@test.local', 'x', 'admin')`
  );
  await pool.query(`
    INSERT INTO leads (school_name, address, phone, website, status, deal_value)
    VALUES
      ('Sunrise Public School', '123 MG Road, Bengaluru', '9876543210', 'https://www.sunrise.example', 'contacted', 5000),
      ('Little Stars Preschool', NULL, NULL, NULL, 'new', 0)
  `);

  const run = (cmd, args) => spawnSync('node', [cmd, ...args], { cwd: ROOT, env, encoding: 'utf8' });

  const migrate1 = run('migrations/run.js', []);
  assert.equal(migrate1.status, 0, migrate1.stderr);

  const { rows: applied } = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
  assert.deepEqual(applied.map((r) => r.filename), [
    '001_phase1_data_foundation.sql',
    '002_phase2_collection_framework.sql',
    '003_phase3_enrichment_dedup.sql',
    '004_phase4_scoring_ai.sql',
    '005_phase5_crm_outreach.sql',
    '006_phase6_analytics.sql',
    '007_location_search.sql',
  ]);

  // Re-running must be a no-op (idempotent).
  const migrate2 = run('migrations/run.js', []);
  assert.equal(migrate2.status, 0, migrate2.stderr);
  const { rows: appliedAgain } = await pool.query('SELECT filename FROM schema_migrations');
  assert.equal(appliedAgain.length, 7);

  // Default org + membership backfilled for the seeded user.
  const { rows: memberships } = await pool.query('SELECT * FROM organization_memberships');
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, 'admin');

  // Backfill: dry run must not write anything.
  const dry = run('scripts/backfill-legacy-leads.js', []);
  assert.equal(dry.status, 0, dry.stderr);
  const { rows: linksBeforeApply } = await pool.query('SELECT * FROM legacy_lead_links');
  assert.equal(linksBeforeApply.length, 0);

  // Apply: creates companies/opportunities/links for both leads.
  const apply1 = run('scripts/backfill-legacy-leads.js', ['--apply']);
  assert.equal(apply1.status, 0, apply1.stderr);
  const { rows: linksAfterApply } = await pool.query('SELECT * FROM legacy_lead_links ORDER BY legacy_lead_id');
  assert.equal(linksAfterApply.length, 2);

  const { rows: companies } = await pool.query('SELECT * FROM companies ORDER BY name');
  assert.equal(companies.length, 2);
  const sunrise = companies.find((c) => c.name === 'Sunrise Public School');
  assert.equal(sunrise.normalized_domain, 'sunrise.example');

  const { rows: locations } = await pool.query('SELECT * FROM company_locations');
  assert.equal(locations.length, 1); // only the lead with an address

  const { rows: opportunities } = await pool.query('SELECT * FROM opportunities ORDER BY legacy_lead_id');
  assert.equal(opportunities.length, 2);
  assert.equal(opportunities[0].stage, 'contacted');
  assert.equal(Number(opportunities[0].deal_value), 5000);

  // Re-applying must be idempotent: no duplicate companies/links.
  const apply2 = run('scripts/backfill-legacy-leads.js', ['--apply']);
  assert.equal(apply2.status, 0, apply2.stderr);
  const { rows: linksAfterSecondApply } = await pool.query('SELECT * FROM legacy_lead_links');
  assert.equal(linksAfterSecondApply.length, 2);
  const { rows: companiesAfterSecondApply } = await pool.query('SELECT * FROM companies');
  assert.equal(companiesAfterSecondApply.length, 2);

  // Legacy leads table itself must be untouched.
  const { rows: leadsStillThere } = await pool.query('SELECT COUNT(*) FROM leads');
  assert.equal(Number(leadsStillThere[0].count), 2);

  await pool.end();
});
