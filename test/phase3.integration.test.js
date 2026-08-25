/**
 * Phase 3 (enrichment + dedup) against a disposable Postgres container and
 * a local HTTP server standing in for a company website. Never touches
 * DATABASE_URL. Skips itself when Docker isn't available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const CONTAINER = 'exora_phase3_test_pg';
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

function startFixtureServer() {
  const routes = {
    '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /blocked\n', type: 'text/plain' },
    '/': {
      status: 200,
      type: 'text/html',
      body: '<html><head><title>Acme Corp</title><meta name="description" content="Widgets since 1990."></head><body>Email us: hello@acme.example or call +91 98765 43210</body></html>',
    },
  };
  const server = http.createServer((req, res) => {
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(route.status, { 'Content-Type': route.type });
    res.end(route.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function startBlockedFixtureServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('User-agent: *\nDisallow: /\n'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Should not be fetched</title></head><body>secret@blocked.example</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('Phase 3: dedup scan (auto-merge + review queue) and website enrichment', { skip: dockerAvailable() ? false : 'Docker not available' }, async (t) => {
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

  const { scanForDuplicates } = require(path.join(ROOT, 'lib/dedup/scan'));
  const { mergeCompanies, AlreadyMergedError } = require(path.join(ROOT, 'lib/dedup/merge'));
  const { enrichCompany } = require(path.join(ROOT, 'lib/enrichment/company'));

  // ── Seed: exact-domain dupe pair, fuzzy-name pair, one clearly distinct ──
  async function insertCompany({ name, normalized_name, domain, normalized_domain }) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO companies (id, org_id, name, normalized_name, domain, normalized_domain) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, DEFAULT_ORG_ID, name, normalized_name, domain || null, normalized_domain || null]
    );
    return id;
  }

  const domainA = await insertCompany({ name: 'Acme Corp', normalized_name: 'acme corp', domain: 'acme.example', normalized_domain: 'acme.example' });
  const domainB = await insertCompany({ name: 'Acme Corporation', normalized_name: 'acme corporation', domain: null, normalized_domain: 'acme.example' });
  const opp = crypto.randomUUID();
  await pool.query(`INSERT INTO opportunities (id, org_id, company_id, name) VALUES ($1,$2,$3,'Test Deal')`, [opp, DEFAULT_ORG_ID, domainB]);
  const loc = crypto.randomUUID();
  await pool.query(`INSERT INTO company_locations (id, org_id, company_id, address_line, is_primary) VALUES ($1,$2,$3,'42 Loser Ave',true)`, [loc, DEFAULT_ORG_ID, domainB]);

  const fuzzyA = await insertCompany({ name: 'Sunrise School', normalized_name: 'sunrise school' });
  const fuzzyB = await insertCompany({ name: 'Sunrise Public School', normalized_name: 'sunrise public school' });

  const distinct = await insertCompany({ name: 'Totally Unrelated Gym', normalized_name: 'totally unrelated gym' });

  const stats = await scanForDuplicates(pool, { org_id: DEFAULT_ORG_ID });
  assert.equal(stats.companies_scanned, 5);
  assert.ok(stats.auto_merged >= 1);
  assert.ok(stats.pending >= 1);

  // Exact-domain pair auto-merged: older (domainA) wins, domainB soft-deleted.
  const { rows: winnerRows } = await pool.query('SELECT * FROM companies WHERE id=$1', [domainA]);
  const { rows: loserRows } = await pool.query('SELECT * FROM companies WHERE id=$1', [domainB]);
  assert.equal(loserRows[0].deleted_at !== null, true);
  assert.equal(loserRows[0].merged_into, domainA);
  assert.equal(winnerRows[0].deleted_at, null);

  const { rows: repointedOpp } = await pool.query('SELECT * FROM opportunities WHERE id=$1', [opp]);
  assert.equal(repointedOpp[0].company_id, domainA);
  const { rows: repointedLoc } = await pool.query('SELECT * FROM company_locations WHERE id=$1', [loc]);
  assert.equal(repointedLoc[0].company_id, domainA);

  const { rows: mergeLog } = await pool.query('SELECT * FROM entity_merges WHERE loser_id=$1', [domainB]);
  assert.equal(mergeLog.length, 1);
  assert.equal(mergeLog[0].auto, true);

  const { rows: autoCandidateRow } = await pool.query(
    `SELECT * FROM duplicate_candidates WHERE entity_type='company' AND status='auto_merged'`
  );
  assert.equal(autoCandidateRow.length, 1);

  // Fuzzy pair: flagged for review, NOT merged.
  const { rows: pendingRow } = await pool.query(
    `SELECT * FROM duplicate_candidates WHERE status='pending' AND entity_type='company'`
  );
  assert.equal(pendingRow.length, 1);
  const pendingIds = [pendingRow[0].entity_id_a, pendingRow[0].entity_id_b].sort();
  assert.deepEqual(pendingIds, [fuzzyA, fuzzyB].sort());
  const { rows: fuzzyStillActive } = await pool.query('SELECT deleted_at FROM companies WHERE id = ANY($1::uuid[])', [[fuzzyA, fuzzyB]]);
  assert.ok(fuzzyStillActive.every((r) => r.deleted_at === null));

  // Distinct company: no candidate at all.
  const { rows: distinctCandidates } = await pool.query(
    `SELECT * FROM duplicate_candidates WHERE entity_id_a=$1 OR entity_id_b=$1`, [distinct]
  );
  assert.equal(distinctCandidates.length, 0);

  // Re-running the scan must not duplicate the merge or re-flag a resolved pair.
  const stats2 = await scanForDuplicates(pool, { org_id: DEFAULT_ORG_ID });
  assert.equal(stats2.auto_merged, 0); // already merged, AlreadyMergedError swallowed
  const { rows: mergeLogAgain } = await pool.query('SELECT * FROM entity_merges WHERE loser_id=$1', [domainB]);
  assert.equal(mergeLogAgain.length, 1);

  // Reviewed (manual) merge of the fuzzy pair, mirroring the confirm route.
  await mergeCompanies(pool, { org_id: DEFAULT_ORG_ID, winner_id: fuzzyA, loser_id: fuzzyB, confidence: pendingRow[0].confidence, reasons: pendingRow[0].reasons, auto: false, merged_by: null });
  const { rows: fuzzyLoserAfter } = await pool.query('SELECT deleted_at, merged_into FROM companies WHERE id=$1', [fuzzyB]);
  assert.equal(fuzzyLoserAfter[0].merged_into, fuzzyA);

  // Merging an already-merged pair again must raise AlreadyMergedError, not corrupt data.
  await assert.rejects(
    () => mergeCompanies(pool, { org_id: DEFAULT_ORG_ID, winner_id: fuzzyA, loser_id: fuzzyB }),
    AlreadyMergedError
  );

  // ── Website enrichment: allowed page ──
  const fixture = await startFixtureServer();
  t.after(() => fixture.server.close());
  const enrichTarget = await insertCompany({ name: 'Enrich Target', normalized_name: 'enrich target', domain: 'acme.enrichtest', normalized_domain: 'acme.enrichtest' });

  // enrichCompany always crawls https://<domain>; 'acme.enrichtest' doesn't resolve, so this
  // exercises the failure path end-to-end (job-facing behavior: never throws, always records
  // provenance and stamps enriched_at). The success path (contacts written, fields filled) is
  // verified below via crawlWebsite + findOrCreateContact directly against the local fixture.
  const result = await enrichCompany(pool, { org_id: DEFAULT_ORG_ID, company_id: enrichTarget });
  assert.equal(result.skipped, false);
  const { rows: enrichedCompanyRow } = await pool.query('SELECT enriched_at FROM companies WHERE id=$1', [enrichTarget]);
  assert.ok(enrichedCompanyRow[0].enriched_at !== null);
  const { rows: enrichRecords } = await pool.query(
    `SELECT * FROM source_records WHERE company_id=$1 AND source_type='website_enrichment'`, [enrichTarget]
  );
  assert.equal(enrichRecords.length, 1);
  assert.equal(enrichRecords[0].status, 'error'); // unreachable fake domain

  const { crawlWebsite } = require(path.join(ROOT, 'lib/enrichment/website'));
  const crawl = await crawlWebsite({ domain: 'acme.enrichtest', baseUrl: `http://127.0.0.1:${fixture.port}` });
  assert.equal(crawl.title, 'Acme Corp');
  assert.equal(crawl.description, 'Widgets since 1990.');
  assert.deepEqual(crawl.emails, ['hello@acme.example']);
  assert.equal(crawl.pages_fetched.length, 1);
  assert.equal(crawl.skipped_reason, undefined);

  // Drive enrichCompany's DB-writing logic using this same crawl result by
  // calling the same contact-creation path it uses, to verify verified=true
  // contacts and provenance get written correctly.
  const { findOrCreateContact } = require(path.join(ROOT, 'lib/companies'));
  const contact = await findOrCreateContact(pool, {
    org_id: DEFAULT_ORG_ID, company_id: enrichTarget, email: crawl.emails[0], phone: crawl.phones[0],
    source: 'website_enrichment', verified: true,
  });
  assert.equal(contact.email_verified, true);
  assert.equal(contact.phone_verified, true);
  assert.equal(contact.source, 'website_enrichment');

  // ── Website enrichment: robots.txt disallow is respected ──
  const blocked = await startBlockedFixtureServer();
  t.after(() => blocked.server.close());
  const blockedCrawl = await crawlWebsite({ domain: 'blocked.enrichtest', baseUrl: `http://127.0.0.1:${blocked.port}` });
  assert.equal(blockedCrawl.skipped_reason, 'disallowed by robots.txt');
  assert.equal(blockedCrawl.emails.length, 0);
  assert.equal(blockedCrawl.pages_fetched.length, 0);

  await pool.end();
});
