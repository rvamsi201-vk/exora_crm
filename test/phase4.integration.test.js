/**
 * Phase 4 (scoring + AI research) against a disposable Postgres container.
 * Never touches DATABASE_URL, never calls a real AI API (researchCompany's
 * generateFn is injected for the "configured" scenarios). Skips itself
 * when Docker isn't available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const CONTAINER = 'exora_phase4_test_pg';
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

function dockerAvailable() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}

async function waitForPg(pool, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try { await pool.query('SELECT 1'); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('Postgres did not become ready in time');
}

test('Phase 4: company scoring (versioned) and AI research (skipped/completed/unstructured/error)', { skip: dockerAvailable() ? false : 'Docker not available' }, async (t) => {
  try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* ignore */ }
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

  await pool.query(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_schema.sql'), 'utf8'));
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

  const { computeCompanyScore } = require(path.join(ROOT, 'lib/scoring/company'));
  const { researchCompany } = require(path.join(ROOT, 'lib/ai/research'));

  // ── Seed a company with real supporting data: legacy rating (fit),
  // a verified contact + location (completeness), an opportunity (intent),
  // and source_records (engagement + research grounding). No live website
  // crawl involved (no domain), keeping this test network-free.
  const companyId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO companies (id, org_id, name, normalized_name, description) VALUES ($1,$2,'Acme Corp','acme corp','Widgets since 1990')`,
    [companyId, DEFAULT_ORG_ID]
  );
  await pool.query(
    `INSERT INTO company_locations (id, org_id, company_id, address_line, is_primary) VALUES ($1,$2,$3,'1 Main St',true)`,
    [crypto.randomUUID(), DEFAULT_ORG_ID, companyId]
  );
  const contactId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO contacts (id, org_id, company_id, name, title, email, phone, email_verified, phone_verified)
     VALUES ($1,$2,$3,'Jane Doe','Owner','jane@acme.example','+919876543210',true,true)`,
    [contactId, DEFAULT_ORG_ID, companyId]
  );
  await pool.query(
    `INSERT INTO opportunities (id, org_id, company_id, name, stage) VALUES ($1,$2,$3,'Acme Deal','qualified')`,
    [crypto.randomUUID(), DEFAULT_ORG_ID, companyId]
  );

  const legacyLeadRes = await pool.query(
    `INSERT INTO leads (school_name, rating, reviews) VALUES ('Acme Corp', 4.8, 300) RETURNING id`
  );
  const legacyLeadId = legacyLeadRes.rows[0].id;
  await pool.query(
    `INSERT INTO legacy_lead_links (id, legacy_lead_id, org_id, company_id) VALUES ($1,$2,$3,$4)`,
    [crypto.randomUUID(), legacyLeadId, DEFAULT_ORG_ID, companyId]
  );

  const sourceRecordId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO source_records (id, org_id, source_type, external_ref, raw_payload, company_id, status)
     VALUES ($1,$2,'manual','seed','{"note":"seed data"}',$3,'collected')`,
    [sourceRecordId, DEFAULT_ORG_ID, companyId]
  );

  // ── Scoring ──
  const score1 = await computeCompanyScore(pool, { org_id: DEFAULT_ORG_ID, company_id: companyId });
  assert.equal(score1.is_current, true);
  assert.equal(Number(score1.fit_score), 100); // rating 4.8 + 300 reviews = max legacy points
  // No domain/industry on this company, so completeness = location(15) + verified_contact(30) + description(15) = 60.
  assert.equal(Number(score1.completeness_score), 60);
  assert.equal(Number(score1.intent_score), 70); // 'qualified' stage
  assert.ok(Number(score1.opportunity_score) > 0); // no domain => all gaps => opportunity=100
  assert.equal(Number(score1.opportunity_score), 100);
  assert.ok(score1.explanation.weights);
  assert.ok(score1.explanation.components.fit.source === 'legacy_rating_reviews');

  // Re-scoring must version, not overwrite: old row demoted, new row current.
  const score2 = await computeCompanyScore(pool, { org_id: DEFAULT_ORG_ID, company_id: companyId });
  const { rows: allScores } = await pool.query('SELECT * FROM company_scores WHERE company_id=$1 ORDER BY computed_at ASC', [companyId]);
  assert.equal(allScores.length, 2);
  assert.equal(allScores[0].is_current, false);
  assert.equal(allScores[1].is_current, true);
  assert.equal(allScores[1].id, score2.id);

  // ── AI research: unconfigured (real default path) → skipped, no content ──
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_KEY;
  const skipped = await researchCompany(pool, { org_id: DEFAULT_ORG_ID, company_id: companyId });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.summary, null);
  assert.match(skipped.error, /not configured/);

  // ── AI research: configured (injected generateFn), well-formed JSON ──
  const fakeGoodResponse = {
    text: JSON.stringify({
      summary: 'Acme Corp is an established widget maker with strong reviews.',
      buying_signals: ['300 reviews, 4.8 rating — established, credible business'],
      decision_makers: [{ name: 'Jane Doe', title: 'Owner', note: 'Primary verified contact on file' }],
      talking_points: ['Highlight reliability given strong review history'],
      outreach_draft: 'Hi Jane, congrats on the strong reviews...',
    }),
    model: 'fake-model-1', provider: 'fake',
  };
  const completed = await researchCompany(pool, {
    org_id: DEFAULT_ORG_ID, company_id: companyId, requested_by: null,
    generateFn: async () => fakeGoodResponse,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.provider, 'fake');
  assert.deepEqual(JSON.parse(JSON.stringify(completed.source_record_ids)), [sourceRecordId]);
  assert.equal(completed.decision_makers[0].name, 'Jane Doe'); // only from real contacts data

  // ── AI research: configured, model returns non-JSON prose ──
  const unstructured = await researchCompany(pool, {
    org_id: DEFAULT_ORG_ID, company_id: companyId,
    generateFn: async () => ({ text: 'Sorry, I cannot format this as JSON right now.', model: 'fake-model-1', provider: 'fake' }),
  });
  assert.equal(unstructured.status, 'completed_unstructured');
  assert.equal(unstructured.summary, 'Sorry, I cannot format this as JSON right now.');

  // ── AI research: provider call throws ──
  const errored = await researchCompany(pool, {
    org_id: DEFAULT_ORG_ID, company_id: companyId,
    generateFn: async () => { throw new Error('upstream 503'); },
  });
  assert.equal(errored.status, 'error');
  assert.match(errored.error, /upstream 503/);

  // Every research attempt is recorded, not just the last — full history.
  const { rows: researchHistory } = await pool.query('SELECT status FROM company_research WHERE company_id=$1 ORDER BY created_at ASC', [companyId]);
  assert.deepEqual(researchHistory.map((r) => r.status), ['skipped', 'completed', 'completed_unstructured', 'error']);

  await pool.end();
});
