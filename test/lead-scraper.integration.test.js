/**
 * Deterministic, mocked-data proof of the location-validation and
 * partial-failure behavior in lead-scraper.js's saveScrapedPlaces — no
 * live Serper call. Runs migrations 001-007 against a disposable Postgres
 * container. Never touches DATABASE_URL of the parent process except to
 * point it at this container. Skips itself when Docker isn't available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const CONTAINER = 'exora_lead_scraper_test_pg';
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

test('lead-scraper saveScrapedPlaces: location filtering, aliases, partial-failure isolation', { skip: dockerAvailable() ? false : 'Docker not available' }, async (t) => {
  try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* container may not exist yet */ }
  execSync(
    `docker run --rm -d --name ${CONTAINER} -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 postgres:16-alpine`,
    { stdio: 'ignore' }
  );
  t.after(() => { try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* best effort */ } });

  const port = execSync(`docker port ${CONTAINER} 5432/tcp`).toString().trim().split(':').pop();
  const databaseUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  const migrateEnv = { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL_MODE: 'disable', NODE_ENV: 'test' };

  const setupPool = new Pool({ connectionString: databaseUrl, ssl: false });
  await waitForPg(setupPool);

  const legacySql = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_schema.sql'), 'utf8');
  await setupPool.query(legacySql);

  const migrate = spawnSync('node', ['migrations/run.js'], { cwd: ROOT, env: migrateEnv, encoding: 'utf8' });
  assert.equal(migrate.status, 0, migrate.stderr);
  await setupPool.end();

  // lead-scraper.js constructs its own module-level Pool from
  // process.env.DATABASE_URL at require time, and asserts it isn't the
  // blocked remote host — point it at this disposable container so that
  // guard passes regardless of what .env/.env.local hold, then override
  // with an explicit `pool` on every saveScrapedPlaces call below anyway.
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_SSL_MODE = 'disable';
  const { saveScrapedPlaces } = require(path.join(ROOT, 'lead-scraper'));

  const pool = new Pool({ connectionString: databaseUrl, ssl: false });
  t.after(() => pool.end());

  const campaignId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await pool.query(`INSERT INTO discovery_campaigns (id, org_id, name, source_type) VALUES ($1,$2,'Test Campaign','serper')`, [campaignId, DEFAULT_ORG_ID]);
  await pool.query(`INSERT INTO campaign_runs (id, org_id, campaign_id, status) VALUES ($1,$2,$3,'running')`, [runId, DEFAULT_ORG_ID, campaignId]);

  const call = (places, location, query = 'gyms', domain = 'gym') =>
    saveScrapedPlaces(places, { query, domain, location, org_id: DEFAULT_ORG_ID, campaignId, runId, pool });

  // ── Koramangala, Bengaluru: valid result + unrelated USA/UK + missing address + malformed ──
  const r1 = await call([
    { title: 'Cult Fit Koramangala', address: '80 Feet Rd, Koramangala 4th Block, Bengaluru, Karnataka 560034', phoneNumber: '9876543210', rating: 4.5, reviews: 120, website: 'cultkora.example', placeId: 'kora-1' },
    { title: 'NYC Fitness Club', address: '221 Baker St, New York, NY 10001, USA', rating: 4.2, reviews: 80, placeId: 'usa-1' },
    { title: 'London Gym', address: '10 Downing St, London, UK', rating: 4.0, reviews: 50, placeId: 'uk-1' },
    { title: 'No Address Gym', rating: 4.1, reviews: 30, placeId: 'noaddr-1' },
    { address: 'Koramangala, Bengaluru', rating: 4.0, placeId: 'malformed-1' }, // no title/name
  ], { area: 'Koramangala', city: 'Bengaluru' });

  assert.equal(r1.saved.length, 1, 'only the Bengaluru result should be saved');
  assert.equal(r1.saved[0].school_name, 'Cult Fit Koramangala');
  assert.equal(r1.saved[0].city, 'Bengaluru');
  assert.equal(r1.saved[0].area, 'Koramangala');
  assert.equal(r1.rejected.length, 3, 'USA, UK, and no-address results are all rejected');
  assert.ok(r1.rejected.some((x) => x.name === 'NYC Fitness Club'));
  assert.ok(r1.rejected.some((x) => x.name === 'London Gym'));
  assert.ok(r1.rejected.some((x) => x.name === 'No Address Gym'));
  assert.equal(r1.errors.length, 1, 'the title-less result is recorded as a malformed-result error');
  assert.match(r1.errors[0].error, /missing title\/name/);

  // ── Andheri, Mumbai: same shape, plus the Bombay alias ──
  const r2 = await call([
    { title: 'Fresh Mart Andheri', address: 'SV Road, Andheri West, Bombay, Maharashtra 400058', phoneNumber: '9812345678', rating: 4.3, reviews: 60, placeId: 'andheri-1' },
    { title: 'Chicago Grocers', address: '5 Michigan Ave, Chicago, IL, USA', rating: 4.0, reviews: 40, placeId: 'usa-2' },
  ], { area: 'Andheri', city: 'Mumbai' }, 'grocery stores', 'grocery');

  assert.equal(r2.saved.length, 1);
  assert.equal(r2.saved[0].school_name, 'Fresh Mart Andheri');
  assert.equal(r2.rejected.length, 1);

  // ── Hyderabad (city only, no area) ──
  const r3 = await call([
    { title: 'Deccan Dental Care', address: 'Road No 36, Jubilee Hills, Hyderabad, Telangana 500033', phoneNumber: '9955512345', rating: 4.6, reviews: 200, placeId: 'hyd-1' },
    { title: 'Some Manchester Clinic', address: '1 Piccadilly, Manchester, UK', rating: 4.1, reviews: 20, placeId: 'uk-2' },
  ], { city: 'Hyderabad' }, 'dentists', 'clinic');

  assert.equal(r3.saved.length, 1);
  assert.equal(r3.saved[0].school_name, 'Deccan Dental Care');
  assert.equal(r3.rejected.length, 1);

  // ── Partial DB-write failure must not roll back the rest of the batch ──
  // A non-numeric `rating` fails the Postgres NUMERIC cast on the leads
  // insert — a genuine, deterministic per-item DB error, not a location
  // rejection or a graceful dedup skip.
  const r4 = await call([
    { title: 'Good Clinic One', address: 'Road No 1, Hyderabad, Telangana', phoneNumber: '9000000001', rating: 4.3, reviews: 40, placeId: 'good-1' },
    { title: 'Bad Rating Clinic', address: 'Road No 2, Hyderabad, Telangana', rating: 'not-a-number', reviews: 10, placeId: 'bad-1' },
    { title: 'Good Clinic Two', address: 'Road No 3, Hyderabad, Telangana', phoneNumber: '9000000003', rating: 4.1, reviews: 15, placeId: 'good-2' },
  ], { city: 'Hyderabad' }, 'clinics', 'clinic');

  assert.equal(r4.saved.length, 2, 'both good clinics save despite the bad-rating item failing');
  assert.equal(r4.saved.map((l) => l.school_name).sort().join(','), 'Good Clinic One,Good Clinic Two');
  assert.equal(r4.errors.length, 1);
  assert.match(r4.errors[0].error, /numeric/i);

  // ── Every rejected/errored result is recorded with its exact reason, not silently dropped ──
  const { rows: errorRecords } = await pool.query(`SELECT * FROM source_records WHERE status='error' AND run_id=$1 ORDER BY created_at`, [runId]);
  assert.equal(errorRecords.length, 4 /* r1: usa, uk, no-address, malformed */ + 1 /* r2: usa */ + 1 /* r3: uk */ + 1 /* r4: bad rating */);
  assert.ok(errorRecords.some((r) => /location mismatch: city "Bengaluru" not found/.test(r.error)));
  assert.ok(errorRecords.some((r) => /missing address for a location-constrained search/.test(r.error)));
  assert.ok(errorRecords.some((r) => /missing title\/name/.test(r.error)));
  assert.ok(errorRecords.some((r) => /numeric/i.test(r.error)));

  // ── Every successfully-saved result is persisted across the full chain ──
  const { rows: companies } = await pool.query(`SELECT * FROM companies WHERE org_id=$1`, [DEFAULT_ORG_ID]);
  assert.equal(companies.length, 5); // kora-1, andheri-1, hyd-1, good-1, good-2
  const { rows: opportunities } = await pool.query(`SELECT * FROM opportunities WHERE campaign_id=$1`, [campaignId]);
  assert.equal(opportunities.length, 5);
  const { rows: links } = await pool.query(`SELECT * FROM legacy_lead_links WHERE org_id=$1`, [DEFAULT_ORG_ID]);
  assert.equal(links.length, 5);
  const { rows: locations } = await pool.query(
    `SELECT cl.* FROM company_locations cl JOIN companies c ON c.id = cl.company_id WHERE c.org_id=$1`,
    [DEFAULT_ORG_ID]
  );
  assert.ok(locations.every((l) => l.city && l.normalized_city), 'structured city is stored on every location row');
});
