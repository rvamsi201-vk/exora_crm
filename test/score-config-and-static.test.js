/**
 * Regression test for two bugs fixed together:
 *  1. index.html's Score Engine Settings called /score-config and
 *     PATCH /score-config/:id without an Authorization header, so both
 *     silently failed against the server's actual auth requirements.
 *  2. Homepage/static-file behavior (GET / serves index.html; only
 *     index.html and logo.png are publicly downloadable; server.js,
 *     package.json, node_modules, etc. are not).
 *
 * This test boots the real server.js against a disposable Postgres
 * container and exercises the actual HTTP contract the frontend fix
 * depends on. Never touches DATABASE_URL. Skips itself when Docker isn't
 * available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawn } = require('node:child_process');
const path = require('node:path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const CONTAINER = 'exora_score_static_test_pg';
const PORT = 34591;
const BASE = `http://127.0.0.1:${PORT}`;

function dockerAvailable() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}

async function waitForPg(pool, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try { await pool.query('SELECT 1'); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('Postgres did not become ready in time');
}

async function waitForHttp(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

test('score-config auth fix + homepage/static security', { skip: dockerAvailable() ? false : 'Docker not available' }, async (t) => {
  try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  execSync(
    `docker run --rm -d --name ${CONTAINER} -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 postgres:16-alpine`,
    { stdio: 'ignore' }
  );
  t.after(() => { try { execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' }); } catch { /* best effort */ } });

  const pgPort = execSync(`docker port ${CONTAINER} 5432/tcp`).toString().trim().split(':').pop();
  const databaseUrl = `postgres://postgres:test@127.0.0.1:${pgPort}/postgres`;
  const pool = new Pool({ connectionString: databaseUrl, ssl: false });
  await waitForPg(pool);

  // Let the real server initDB() build the legacy schema (leads/team/users/
  // score_config/domains) — this test only touches routes that predate the
  // Phase 1-6 migrations, so no migration run is needed here.
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
      DATABASE_URL: databaseUrl,
      DATABASE_SSL_MODE: 'disable',
      ALLOWED_ORIGINS: BASE,
      JWT_SECRET: 'test-only-secret-at-least-32-characters-long',
      AUTO_INIT_DB: 'true',
    },
    stdio: 'pipe',
  });
  t.after(() => { server.kill(); });
  server.stderr.on('data', () => {}); // keep pipes drained

  await waitForHttp(`${BASE}/health`);
  // initDB() runs async after listen(); poll until score_config is seeded.
  for (let i = 0; i < 40; i++) {
    const { rows } = await pool.query(`SELECT to_regclass('score_config') AS t`);
    if (rows[0].t) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const adminHash = await bcrypt.hash('AdminPass12345', 10);
  const salesHash = await bcrypt.hash('SalesPass12345', 10);
  await pool.query(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin','admin@test.local',$1,'admin')`, [adminHash]);
  await pool.query(`INSERT INTO users (name, email, password_hash, role) VALUES ('Sales','sales@test.local',$1,'salesperson')`, [salesHash]);

  const login = async (email, password) => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    return body.token;
  };
  const adminToken = await login('admin@test.local', 'AdminPass12345');
  const salesToken = await login('sales@test.local', 'SalesPass12345');
  assert.ok(adminToken && salesToken, 'both logins should succeed');

  // ── Bug 1: score-config must require auth, and the fixed frontend now sends it ──
  const noAuthGet = await fetch(`${BASE}/api/score-config`);
  assert.equal(noAuthGet.status, 401, 'GET /score-config without a token must be rejected (this is why the old unauthenticated fetch broke)');

  const authGet = await fetch(`${BASE}/api/score-config`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(authGet.status, 200);
  const rows = await authGet.json();
  assert.ok(Array.isArray(rows) && rows.length > 0, 'GET /score-config with a valid token returns an array of rules');
  const target = rows.find((r) => r.category === 'base');
  assert.ok(target, 'seeded score_config includes a base-category rule to PATCH');

  const noAuthPatch = await fetch(`${BASE}/api/score-config/${target.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: 99 }),
  });
  assert.equal(noAuthPatch.status, 401, 'PATCH without a token must be rejected (the original saveScoreRule bug: it never sent one)');

  const salesPatch = await fetch(`${BASE}/api/score-config/${target.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${salesToken}` }, body: JSON.stringify({ points: 99 }),
  });
  assert.equal(salesPatch.status, 403, 'a non-admin token must be rejected — admin-only authorization is enforced server-side');

  const adminPatch = await fetch(`${BASE}/api/score-config/${target.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ points: 42, enabled: false }),
  });
  assert.equal(adminPatch.status, 200);
  const patched = await adminPatch.json();
  assert.equal(patched.points, 42);
  assert.equal(patched.enabled, false);

  const reGet = await fetch(`${BASE}/api/score-config`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const reRows = await reGet.json();
  assert.equal(reRows.find((r) => r.id === target.id).points, 42, 'the admin PATCH actually persisted');

  // ── Bug 2: homepage + static-file exposure ──
  const home = await fetch(`${BASE}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') || '', /text\/html/);
  const homeBody = await home.text();
  assert.match(homeBody, /<title>ExoraLeadForge<\/title>/);

  const logo = await fetch(`${BASE}/logo.png`);
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type') || '', /image\/png/);

  for (const path_ of ['/server.js', '/package.json', '/ecosystem.config.js', '/node_modules/express/package.json', '/.env']) {
    const res = await fetch(`${BASE}${path_}`);
    assert.equal(res.status, 404, `${path_} must not be publicly downloadable`);
  }

  const apiStatus = await fetch(`${BASE}/api/`);
  assert.equal(apiStatus.status, 200);
  assert.equal((await apiStatus.json()).status, 'ok');

  const health = await fetch(`${BASE}/health`);
  assert.equal(health.status, 200);

  await pool.end();
});
