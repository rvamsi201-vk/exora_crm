/**
 * Runs migrations 001+002 and exercises the job queue/worker against a
 * disposable Postgres container. Never touches DATABASE_URL. Skips itself
 * when Docker isn't available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const CONTAINER = 'exora_jobs_test_pg';

function dockerAvailable() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}

async function waitForPg(pool, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try { await pool.query('SELECT 1'); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('Postgres did not become ready in time');
}

test('jobs table: enqueue, claim, complete, and retry-with-backoff', { skip: dockerAvailable() ? false : 'Docker not available' }, async (t) => {
  try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* container may not exist yet */ }
  execSync(
    `docker run --rm -d --name ${CONTAINER} -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 postgres:16-alpine`,
    { stdio: 'ignore' }
  );
  t.after(() => { try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* best effort */ } });

  const port = execSync(`docker port ${CONTAINER} 5432/tcp`).toString().trim().split(':').pop();
  const databaseUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  const env = { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL_MODE: 'disable', NODE_ENV: 'test' };

  const pool = new Pool({ connectionString: databaseUrl, ssl: false });
  await waitForPg(pool);

  const legacySql = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_schema.sql'), 'utf8');
  await pool.query(legacySql);

  const migrate = spawnSync('node', ['migrations/run.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(migrate.status, 0, migrate.stderr);

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

  const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';
  const { enqueueJob, claimNextJob, completeJob, failJob } = require(path.join(ROOT, 'lib/jobs/queue'));

  // enqueue + claim + complete
  const job = await enqueueJob(pool, { org_id: DEFAULT_ORG_ID, type: 'manual', payload: { name: 'Acme' } });
  assert.equal(job.status, 'queued');
  const claimed = await claimNextJob(pool);
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);

  const noneLeft = await claimNextJob(pool);
  assert.equal(noneLeft, null);

  await completeJob(pool, claimed.id, { found: 1 });
  const { rows: doneRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [claimed.id]);
  assert.equal(doneRows[0].status, 'succeeded');
  assert.equal(doneRows[0].result.found, 1);

  // enqueue + retry then terminal failure (max_attempts=2)
  const flaky = await enqueueJob(pool, { org_id: DEFAULT_ORG_ID, type: 'manual', payload: {}, max_attempts: 2 });
  const claim1 = await claimNextJob(pool);
  const outcome1 = await failJob(pool, claim1, new Error('boom'));
  assert.equal(outcome1, 'retrying');
  const { rows: retryRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [flaky.id]);
  assert.equal(retryRows[0].status, 'queued');
  assert.ok(new Date(retryRows[0].run_after) > new Date());

  // force it claimable now to drive it to terminal failure
  await pool.query(`UPDATE jobs SET run_after = NOW() WHERE id=$1`, [flaky.id]);
  const claim2 = await claimNextJob(pool);
  assert.equal(claim2.attempts, 2);
  const outcome2 = await failJob(pool, claim2, new Error('boom again'));
  assert.equal(outcome2, 'failed');
  const { rows: failedRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [flaky.id]);
  assert.equal(failedRows[0].status, 'failed');

  await pool.end();
});

test('worker end-to-end: campaign run via csv collector creates company + source_records + succeeded run', { skip: dockerAvailable() ? false : 'Docker not available' }, async (t) => {
  const container2 = `${CONTAINER}_e2e`;
  try { execSync(`docker rm -f ${container2}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  execSync(
    `docker run --rm -d --name ${container2} -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 postgres:16-alpine`,
    { stdio: 'ignore' }
  );
  t.after(() => { try { execSync(`docker rm -f ${container2}`, { stdio: 'ignore' }); } catch { /* best effort */ } });

  const port = execSync(`docker port ${container2} 5432/tcp`).toString().trim().split(':').pop();
  const databaseUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  const env = { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL_MODE: 'disable', NODE_ENV: 'test' };
  const pool = new Pool({ connectionString: databaseUrl, ssl: false });
  await waitForPg(pool);

  await pool.query(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_schema.sql'), 'utf8'));
  const migrate = spawnSync('node', ['migrations/run.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(migrate.status, 0, migrate.stderr);

  const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';
  const crypto = require('node:crypto');
  const { enqueueJob, claimNextJob } = require(path.join(ROOT, 'lib/jobs/queue'));
  const { runJob } = require(path.join(ROOT, 'lib/jobs/worker'));

  const campaignId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO discovery_campaigns (id, org_id, name, source_type) VALUES ($1,$2,'CSV Import Test','csv')`,
    [campaignId, DEFAULT_ORG_ID]
  );
  const runId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO campaign_runs (id, org_id, campaign_id, status) VALUES ($1,$2,$3,'pending')`,
    [runId, DEFAULT_ORG_ID, campaignId]
  );

  const csv_text = 'name,website\nSunrise School,sunrise.example\nNo Website School,';
  const job = await enqueueJob(pool, { org_id: DEFAULT_ORG_ID, campaign_id: campaignId, run_id: runId, type: 'csv', payload: { csv_text } });
  const claimed = await claimNextJob(pool);
  assert.equal(claimed.id, job.id);

  await runJob(pool, claimed);

  const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [job.id]);
  assert.equal(jobRows[0].status, 'succeeded');
  assert.equal(jobRows[0].result.found, 2);

  const { rows: runRows } = await pool.query('SELECT * FROM campaign_runs WHERE id=$1', [runId]);
  assert.equal(runRows[0].status, 'completed');
  assert.equal(runRows[0].stats.companies_created, 2);

  const { rows: companies } = await pool.query('SELECT * FROM companies WHERE org_id=$1 ORDER BY name', [DEFAULT_ORG_ID]);
  assert.equal(companies.length, 2);
  assert.equal(companies.find((c) => c.name === 'Sunrise School').normalized_domain, 'sunrise.example');

  const { rows: records } = await pool.query('SELECT * FROM source_records WHERE run_id=$1', [runId]);
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.source_type === 'csv' && r.status === 'collected'));

  // Re-running the same campaign against the same data must not duplicate companies.
  const runId2 = crypto.randomUUID();
  await pool.query(`INSERT INTO campaign_runs (id, org_id, campaign_id, status) VALUES ($1,$2,$3,'pending')`, [runId2, DEFAULT_ORG_ID, campaignId]);
  const job2 = await enqueueJob(pool, { org_id: DEFAULT_ORG_ID, campaign_id: campaignId, run_id: runId2, type: 'csv', payload: { csv_text } });
  const claimed2 = await claimNextJob(pool);
  await runJob(pool, claimed2);
  const { rows: companiesAfter } = await pool.query('SELECT * FROM companies WHERE org_id=$1', [DEFAULT_ORG_ID]);
  assert.equal(companiesAfter.length, 2);

  await pool.end();
});
