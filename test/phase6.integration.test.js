/**
 * Phase 6 (analytics) against a disposable Postgres container. Seeds a
 * small realistic dataset across every table Phases 1-5 introduced, then
 * exercises every report in lib/analytics/reports.js. Skips itself when
 * Docker isn't available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const CONTAINER = 'exora_phase6_test_pg';
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

test('Phase 6: analytics reports over a seeded Phase 1-5 dataset', { skip: dockerAvailable() ? false : 'Docker not available' }, async (t) => {
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

  const reports = require(path.join(ROOT, 'lib/analytics/reports'));
  const { recordScoreFeedback } = require(path.join(ROOT, 'lib/crm/scoreFeedback'));

  // ── Reps ──
  const repA = (await pool.query(`INSERT INTO team (name, role, email) VALUES ('Rep A','Sales Person','a@x.com') RETURNING id`)).rows[0].id;
  const repB = (await pool.query(`INSERT INTO team (name, role, email) VALUES ('Rep B','Sales Person','b@x.com') RETURNING id`)).rows[0].id;

  // ── Campaign + runs + source_records (source/campaign performance) ──
  const campaignId = crypto.randomUUID();
  await pool.query(`INSERT INTO discovery_campaigns (id, org_id, name, source_type) VALUES ($1,$2,'Bengaluru Schools','serper')`, [campaignId, DEFAULT_ORG_ID]);
  const runOk = crypto.randomUUID(), runFail = crypto.randomUUID();
  await pool.query(`INSERT INTO campaign_runs (id, org_id, campaign_id, status) VALUES ($1,$2,$3,'succeeded')`, [runOk, DEFAULT_ORG_ID, campaignId]);
  await pool.query(`INSERT INTO campaign_runs (id, org_id, campaign_id, status) VALUES ($1,$2,$3,'failed')`, [runFail, DEFAULT_ORG_ID, campaignId]);

  // ── Companies: one enriched, one not; plus a merge pair ──
  const companyWon = crypto.randomUUID(), companyLost = crypto.randomUUID(), companyOpen = crypto.randomUUID();
  await pool.query(`INSERT INTO companies (id, org_id, name, normalized_name, enriched_at) VALUES ($1,$2,'Won Co','won co', NOW())`, [companyWon, DEFAULT_ORG_ID]);
  await pool.query(`INSERT INTO companies (id, org_id, name, normalized_name) VALUES ($1,$2,'Lost Co','lost co')`, [companyLost, DEFAULT_ORG_ID]);
  await pool.query(`INSERT INTO companies (id, org_id, name, normalized_name) VALUES ($1,$2,'Open Co','open co')`, [companyOpen, DEFAULT_ORG_ID]);

  for (const [companyId2, sourceType] of [[companyWon, 'serper'], [companyLost, 'csv'], [companyOpen, 'serper']]) {
    await pool.query(
      `INSERT INTO source_records (id, org_id, campaign_id, run_id, source_type, external_ref, raw_payload, company_id, status)
       VALUES ($1,$2,$3,$4,$5,'ref','{}'::jsonb,$6,'collected')`,
      [crypto.randomUUID(), DEFAULT_ORG_ID, campaignId, runOk, sourceType, companyId2]
    );
  }
  await pool.query(
    `INSERT INTO source_records (id, org_id, source_type, external_ref, raw_payload, status, error) VALUES ($1,$2,'serper','bad','{}'::jsonb,'error','boom')`,
    [crypto.randomUUID(), DEFAULT_ORG_ID]
  );

  // ── Duplicate candidates + a merge ──
  await pool.query(
    `INSERT INTO duplicate_candidates (id, org_id, entity_type, entity_id_a, entity_id_b, confidence, status)
     VALUES ($1,$2,'company',$3,$4,0.97,'auto_merged')`,
    [crypto.randomUUID(), DEFAULT_ORG_ID, companyWon, companyOpen]
  );
  await pool.query(
    `INSERT INTO entity_merges (id, org_id, entity_type, winner_id, loser_id, confidence, auto) VALUES ($1,$2,'company',$3,$4,0.97,true)`,
    [crypto.randomUUID(), DEFAULT_ORG_ID, companyWon, companyOpen]
  );

  // ── Scores (Phase 4) ──
  async function insertScore(companyId2, overall, fit, opp) {
    await pool.query(
      `INSERT INTO company_scores (id, org_id, company_id, fit_score, intent_score, completeness_score, engagement_score, opportunity_score, overall_score, is_current)
       VALUES ($1,$2,$3,$4,50,50,50,$5,$6,true)`,
      [crypto.randomUUID(), DEFAULT_ORG_ID, companyId2, fit, opp, overall]
    );
  }
  await insertScore(companyWon, 85, 90, 80);
  await insertScore(companyLost, 30, 20, 40);

  // ── Opportunities: one won, one lost, one open ──
  const oppWon = crypto.randomUUID(), oppLost = crypto.randomUUID(), oppOpen = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, org_id, company_id, name, stage, deal_value, owner_team_id, campaign_id, created_at, assigned_at, closed_at)
     VALUES ($1,$2,$3,'Won Deal','won',10000,$4,$5, NOW() - INTERVAL '10 days', NOW() - INTERVAL '9 days', NOW() - INTERVAL '2 days')`,
    [oppWon, DEFAULT_ORG_ID, companyWon, repA, campaignId]
  );
  await pool.query(
    `INSERT INTO opportunities (id, org_id, company_id, name, stage, deal_value, owner_team_id, created_at, assigned_at, closed_at)
     VALUES ($1,$2,$3,'Lost Deal','lost',5000,$4, NOW() - INTERVAL '8 days', NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 days')`,
    [oppLost, DEFAULT_ORG_ID, companyLost, repB]
  );
  await pool.query(
    `INSERT INTO opportunities (id, org_id, company_id, name, stage, deal_value, owner_team_id, created_at, assigned_at)
     VALUES ($1,$2,$3,'Open Deal','contacted',3000,$4, NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days')`,
    [oppOpen, DEFAULT_ORG_ID, companyOpen, repA]
  );

  await recordScoreFeedback(pool, { org_id: DEFAULT_ORG_ID, opportunity_id: oppWon, company_id: companyWon, outcome: 'won' });
  await recordScoreFeedback(pool, { org_id: DEFAULT_ORG_ID, opportunity_id: oppLost, company_id: companyLost, outcome: 'lost', lost_reason: 'budget' });

  // ── Tasks (one done, one overdue) for rep A ──
  await pool.query(`INSERT INTO tasks (id, org_id, opportunity_id, title, status, assigned_to_team_id, completed_at) VALUES ($1,$2,$3,'Follow up','done',$4,NOW())`, [crypto.randomUUID(), DEFAULT_ORG_ID, oppWon, repA]);
  await pool.query(`INSERT INTO tasks (id, org_id, opportunity_id, title, status, assigned_to_team_id, due_at) VALUES ($1,$2,$3,'Call back','open',$4, NOW() - INTERVAL '1 days')`, [crypto.randomUUID(), DEFAULT_ORG_ID, oppOpen, repA]);

  // ── Outreach messages ──
  const contactId = crypto.randomUUID();
  await pool.query(`INSERT INTO contacts (id, org_id, company_id, email) VALUES ($1,$2,$3,'x@y.com')`, [contactId, DEFAULT_ORG_ID, companyWon]);
  await pool.query(`INSERT INTO outreach_messages (id, org_id, contact_id, channel, body, status) VALUES ($1,$2,$3,'email','hi','delivered')`, [crypto.randomUUID(), DEFAULT_ORG_ID, contactId]);
  await pool.query(`INSERT INTO outreach_messages (id, org_id, contact_id, channel, body, status) VALUES ($1,$2,$3,'email','hi','replied')`, [crypto.randomUUID(), DEFAULT_ORG_ID, contactId]);
  await pool.query(`INSERT INTO outreach_messages (id, org_id, contact_id, channel, body, status) VALUES ($1,$2,$3,'whatsapp','hi','suppressed')`, [crypto.randomUUID(), DEFAULT_ORG_ID, contactId]);

  // ── Assertions ──
  const sources = await reports.sourceCampaignPerformance(pool, { org_id: DEFAULT_ORG_ID });
  const serperRow = sources.by_source.find((r) => r.source_type === 'serper');
  assert.equal(Number(serperRow.records), 3);
  assert.equal(Number(serperRow.errors), 1);
  const campaignRow = sources.by_campaign.find((r) => r.id === campaignId);
  assert.equal(Number(campaignRow.successful_runs), 1);
  assert.equal(Number(campaignRow.failed_runs), 1);

  const enrichment = await reports.enrichmentDuplicateRates(pool, { org_id: DEFAULT_ORG_ID });
  assert.equal(enrichment.companies_total, 3);
  assert.equal(enrichment.companies_enriched, 1);
  assert.equal(enrichment.enrichment_rate, reports.rate(1, 3));
  assert.ok(enrichment.merges_by_type.some((m) => m.entity_type === 'company' && Number(m.count) === 1));

  const scoring = await reports.scoreConversionAnalysis(pool, { org_id: DEFAULT_ORG_ID });
  const highBucket = scoring.buckets.find((b) => b.bucket === '81-100');
  assert.equal(highBucket.won, 1);
  const lowBucket = scoring.buckets.find((b) => b.bucket === '21-40');
  assert.equal(lowBucket.lost, 1);
  assert.equal(scoring.total_closed, 2);

  const velocity = await reports.pipelineVelocity(pool, { org_id: DEFAULT_ORG_ID });
  assert.ok(velocity.avg_days_to_close_won > 5 && velocity.avg_days_to_close_won < 9);
  assert.ok(velocity.open_by_stage.some((s) => s.stage === 'contacted'));

  const reps = await reports.repPerformance(pool, { org_id: DEFAULT_ORG_ID });
  const repARow = reps.find((r) => r.team_id === repA);
  assert.equal(repARow.won, 1);
  assert.equal(repARow.won_value, 10000);
  assert.equal(repARow.tasks_done, 1);
  assert.equal(repARow.tasks_overdue, 1);
  const repBRow = reps.find((r) => r.team_id === repB);
  assert.equal(repBRow.lost, 1);

  const outreach = await reports.outreachResponseRates(pool, { org_id: DEFAULT_ORG_ID });
  const emailRow = outreach.find((r) => r.channel === 'email');
  assert.equal(emailRow.replied, 1);
  assert.equal(emailRow.reply_rate, 0.5);
  const waRow = outreach.find((r) => r.channel === 'whatsapp');
  assert.equal(waRow.suppressed, 1);

  const revenue = await reports.revenueAndRoi(pool, { org_id: DEFAULT_ORG_ID });
  assert.equal(revenue.revenue_won, 10000);
  assert.equal(revenue.open_count, 1);
  assert.match(revenue.roi_note, /not reported/);
  assert.ok(revenue.revenue_won_by_campaign.some((c) => c.campaign_name === 'Bengaluru Schools' && c.revenue_won === 10000));

  const lostReasons = await reports.lostReasonsAndScoringFeedback(pool, { org_id: DEFAULT_ORG_ID });
  assert.deepEqual(lostReasons.lost_reasons, [{ lost_reason: 'budget', count: 1 }]);
  const wonFeedback = lostReasons.score_by_outcome.find((s) => s.outcome === 'won');
  const lostFeedback = lostReasons.score_by_outcome.find((s) => s.outcome === 'lost');
  assert.equal(wonFeedback.avg_overall_score, 85);
  assert.equal(lostFeedback.avg_overall_score, 30);
  assert.ok(wonFeedback.avg_overall_score > lostFeedback.avg_overall_score, 'won deals should score higher than lost ones in this seeded data');

  await pool.end();
});
