/**
 * Phase 5 (CRM + outreach) against a disposable Postgres container. No
 * outreach adapter ever makes a real network call here — NODE_ENV stays
 * 'test' throughout, which the adapters simulate against unconditionally.
 * Skips itself when Docker isn't available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const CONTAINER = 'exora_phase5_test_pg';
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

test('Phase 5: round-robin assignment + SLA task, stage-change timeline, suppression, and simulated outreach', { skip: dockerAvailable() ? false : 'Docker not available' }, async (t) => {
  try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  execSync(
    `docker run --rm -d --name ${CONTAINER} -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 postgres:16-alpine`,
    { stdio: 'ignore' }
  );
  t.after(() => { try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* best effort */ } });

  const port = execSync(`docker port ${CONTAINER} 5432/tcp`).toString().trim().split(':').pop();
  const databaseUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  const env = { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL_MODE: 'disable', NODE_ENV: 'test' };
  process.env.NODE_ENV = 'test'; // adapters read this live; keep this process's env in sync too
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

  const { pickAssignee, assignOpportunity } = require(path.join(ROOT, 'lib/crm/assignment'));
  const { createSlaFollowUpTask, completeTask } = require(path.join(ROOT, 'lib/crm/tasks'));
  const { recordActivity } = require(path.join(ROOT, 'lib/crm/activity'));
  const { isSuppressed, addSuppression } = require(path.join(ROOT, 'lib/outreach/suppression'));
  const { sendOutreach } = require(path.join(ROOT, 'lib/outreach/send'));

  // ── Seed two reps and a company/contact/opportunity ──
  const repA = (await pool.query(`INSERT INTO team (name, role) VALUES ('Rep A','Sales Person') RETURNING id`)).rows[0].id;
  const repB = (await pool.query(`INSERT INTO team (name, role) VALUES ('Rep B','Sales Person') RETURNING id`)).rows[0].id;

  const companyId = crypto.randomUUID();
  await pool.query(`INSERT INTO companies (id, org_id, name, normalized_name) VALUES ($1,$2,'Acme Corp','acme corp')`, [companyId, DEFAULT_ORG_ID]);
  const contactId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO contacts (id, org_id, company_id, name, email, phone) VALUES ($1,$2,$3,'Jane Doe','jane@acme.example','+919876543210')`,
    [contactId, DEFAULT_ORG_ID, companyId]
  );

  // ── Round robin: with no existing load, picks the lowest team.id first ──
  const first = await pickAssignee(pool, {});
  assert.equal(first, repA);

  const oppId = crypto.randomUUID();
  await pool.query(`INSERT INTO opportunities (id, org_id, company_id, contact_id, name) VALUES ($1,$2,$3,$4,'Acme Deal')`, [oppId, DEFAULT_ORG_ID, companyId, contactId]);
  const assigned = await assignOpportunity(pool, { org_id: DEFAULT_ORG_ID, opportunity_id: oppId, team_id: first });
  assert.equal(assigned.owner_team_id, repA);
  assert.ok(assigned.assigned_at);

  // Now repA has 1 open opportunity — the next pick should load-balance to repB.
  const second = await pickAssignee(pool, {});
  assert.equal(second, repB);

  // ── SLA task auto-created on assignment ──
  const task = await createSlaFollowUpTask(pool, { org_id: DEFAULT_ORG_ID, opportunity_id: oppId, opportunity_name: 'Acme Deal', assigned_to_team_id: repA });
  assert.equal(task.status, 'open');
  assert.ok(task.due_at > new Date());
  const { rows: openTasks } = await pool.query(`SELECT * FROM tasks WHERE opportunity_id=$1 AND status='open'`, [oppId]);
  assert.equal(openTasks.length, 1);

  await completeTask(pool, { org_id: DEFAULT_ORG_ID, task_id: task.id, status: 'done' });
  const { rows: doneTasks } = await pool.query(`SELECT * FROM tasks WHERE id=$1`, [task.id]);
  assert.equal(doneTasks[0].status, 'done');
  assert.ok(doneTasks[0].completed_at);

  // ── Stage change + timeline ──
  await recordActivity(pool, { org_id: DEFAULT_ORG_ID, type: 'stage_changed', company_id: companyId, opportunity_id: oppId, payload: { from: 'new', to: 'contacted' } });
  await pool.query(`UPDATE opportunities SET stage='contacted' WHERE id=$1`, [oppId]);
  const { rows: timeline } = await pool.query(`SELECT * FROM activities WHERE company_id=$1 ORDER BY occurred_at ASC`, [companyId]);
  assert.ok(timeline.some((a) => a.type === 'stage_changed'));

  // ── Suppression blocks a send before any adapter runs ──
  const before = await isSuppressed(pool, { contact_id: contactId, channel: 'email' });
  assert.equal(before.suppressed, false);
  await addSuppression(pool, { org_id: DEFAULT_ORG_ID, contact_id: contactId, channel: 'email', reason: 'requested via reply', source: 'user_request' });
  const after = await isSuppressed(pool, { contact_id: contactId, channel: 'email' });
  assert.equal(after.suppressed, true);

  const suppressedSend = await sendOutreach(pool, { org_id: DEFAULT_ORG_ID, contact_id: contactId, channel: 'email', subject: 'Hi', body: 'Hello Jane', opportunity_id: oppId });
  assert.equal(suppressedSend.status, 'suppressed');
  assert.match(suppressedSend.error, /requested via reply/);

  // Suppression is per-channel: whatsapp is unaffected.
  const whatsappSend = await sendOutreach(pool, { org_id: DEFAULT_ORG_ID, contact_id: contactId, channel: 'whatsapp', body: 'Hello Jane', opportunity_id: oppId });
  assert.equal(whatsappSend.status, 'simulated'); // NODE_ENV=test => always simulated, never a real send
  assert.equal(whatsappSend.sent_at !== null, true);

  // A global opted_out flag blocks every channel, not just one.
  const contact2Id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO contacts (id, org_id, company_id, name, email, phone, opted_out) VALUES ($1,$2,$3,'John Roe','john@acme.example','+919876500000',true)`,
    [contact2Id, DEFAULT_ORG_ID, companyId]
  );
  const optedOutSend = await sendOutreach(pool, { org_id: DEFAULT_ORG_ID, contact_id: contact2Id, channel: 'whatsapp', body: 'Hello John' });
  assert.equal(optedOutSend.status, 'suppressed');

  // ── Full timeline now includes both outreach attempts ──
  const { rows: outreachRows } = await pool.query(`SELECT status, channel FROM outreach_messages WHERE contact_id=$1 ORDER BY created_at ASC`, [contactId]);
  assert.deepEqual(outreachRows.map((r) => `${r.channel}:${r.status}`), ['email:suppressed', 'whatsapp:simulated']);

  await pool.end();
});
