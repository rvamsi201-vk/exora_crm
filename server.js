const { loadEnv, assertNotRemoteDatabase } = require('./lib/env-guard');
loadEnv();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const { scrapeAndSave } = require('./lead-scraper');
const { scoreAllPendingLeads, scoreLead } = require('./lead-scorer');
const { getCollector } = require('./lib/collectors');
const { Parser } = require('json2csv');
const { enqueueJob } = require('./lib/jobs/queue');
const { startWorker } = require('./lib/jobs/worker');
const { findOrCreateCompany, addLocationIfMissing, findOrCreateContact } = require('./lib/companies');
const { mergeCompanies, mergeContacts, AlreadyMergedError } = require('./lib/dedup/merge');
const { pickAssignee, assignOpportunity } = require('./lib/crm/assignment');
const { createTask, createSlaFollowUpTask, completeTask } = require('./lib/crm/tasks');
const { recordActivity } = require('./lib/crm/activity');
const { addSuppression, removeSuppression } = require('./lib/outreach/suppression');
const { recordScoreFeedback } = require('./lib/crm/scoreFeedback');
const analytics = require('./lib/analytics/reports');
const { normalizeLocation, combineQueryWithLocation } = require('./lib/normalize');
const crypto = require('crypto');

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || (!isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS'));
  }
}));
app.use(express.json());

// ── Globals for n8n tracking ──
global.lastN8nTrigger = 'System';
global.lastN8nDomain = 'school';
global.lastN8nLocation = {};

// ── Serve frontend ──
// Only the files the UI actually references are served statically; the
// directory previously served as-is, which exposed server.js, package.json,
// nginx/PM2 config, and node_modules over HTTP.
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

if (isProduction && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-before-production';

function databaseSslConfig() {
  const mode = (process.env.DATABASE_SSL_MODE || 'require').toLowerCase();
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

// ── PostgreSQL Connection ──
assertNotRemoteDatabase(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSslConfig()
});

// ── Auto-create tables on startup ──
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        school_name TEXT,
        address TEXT,
        phone TEXT,
        website TEXT,
        rating NUMERIC,
        reviews INTEGER,
        source TEXT DEFAULT 'n8n',
        status TEXT DEFAULT 'new',
        assigned_id INTEGER,
        deal_value NUMERIC DEFAULT 0,
        domain TEXT DEFAULT 'school',
        notes TEXT,
        assigned_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT unique_lead_name_addr UNIQUE (school_name, address),
        CONSTRAINT unique_lead_name_phone UNIQUE (school_name, phone)
      );
      CREATE TABLE IF NOT EXISTS team (
        id SERIAL PRIMARY KEY,
        name TEXT,
        role TEXT,
        email TEXT,
        phone TEXT,
        color TEXT DEFAULT '#5b6af7',
        status TEXT DEFAULT 'online',
        territory TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'salesperson',
        phone TEXT DEFAULT '',
        territory TEXT DEFAULT '',
        team_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── Call logs, Lead notes, Reminders ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_logs (
        id            SERIAL PRIMARY KEY,
        lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        called_by     TEXT    NOT NULL,
        called_at     TIMESTAMPTZ DEFAULT NOW(),
        duration      INTEGER DEFAULT 0,
        outcome       TEXT    DEFAULT 'no_answer',
        notes         TEXT    DEFAULT '',
        next_followup DATE
      );
      CREATE TABLE IF NOT EXISTS lead_notes (
        id         SERIAL PRIMARY KEY,
        lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        added_by   TEXT    NOT NULL,
        note       TEXT    NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id          SERIAL PRIMARY KEY,
        lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        call_log_id INTEGER REFERENCES call_logs(id) ON DELETE CASCADE,
        remind_at   TIMESTAMPTZ NOT NULL,
        message     TEXT DEFAULT '',
        status      TEXT DEFAULT 'pending',
        created_by  TEXT NOT NULL DEFAULT 'Unknown',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── Score config table ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS score_config (
        id         SERIAL PRIMARY KEY,
        category   TEXT    NOT NULL,
        key        TEXT    NOT NULL UNIQUE,
        label      TEXT    NOT NULL,
        points     INTEGER NOT NULL DEFAULT 0,
        enabled    BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        labels_json JSONB,
        pitches_json JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // ── Score config table migration ──
    await pool.query(`
      ALTER TABLE score_config ADD COLUMN IF NOT EXISTS labels_json JSONB;
      ALTER TABLE score_config ADD COLUMN IF NOT EXISTS pitches_json JSONB;
    `);

    const cfgCount = await pool.query('SELECT COUNT(*) FROM score_config');
    if (parseInt(cfgCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO score_config (category, key, label, points, enabled, sort_order) VALUES
          ('base', 'rating_4_5',   'Rating >= 4.5 stars',     25, true,  1),
          ('base', 'rating_4_0',   'Rating >= 4.0 stars',     20, true,  2),
          ('base', 'rating_3_5',   'Rating >= 3.5 stars',     14, true,  3),
          ('base', 'rating_3_0',   'Rating >= 3.0 stars',      8, true,  4),
          ('base', 'rating_any',   'Rating > 0 (any)',          4, true,  5),
          ('base', 'reviews_200',  '200+ Google reviews',     20, true,  6),
          ('base', 'reviews_100',  '100+ Google reviews',     16, true,  7),
          ('base', 'reviews_50',   '50+ Google reviews',      12, true,  8),
          ('base', 'reviews_20',   '20+ Google reviews',       8, true,  9),
          ('base', 'reviews_5',    '5+ Google reviews',        4, true,  10),
          ('base', 'has_phone',    'Has phone number',        10, true,  11),
          ('base', 'has_website',  'Has website',             15, true,  12),
          ('base', 'has_address',  'Has address',             10, true,  13),
          ('gap',  'crm',         'No CRM / Enquiry System', 10, true,  20),
          ('gap',  'lms',         'No LMS / Online Learning',10, true,  21),
          ('gap',  'payment',     'No Online Fee Payment',   10, true,  22),
          ('gap',  'admission',   'No Admission Portal',      8, true,  23),
          ('gap',  'app',         'No Mobile App',            7, true,  24),
          ('gap',  'attendance',  'No Attendance / ERP',      7, true,  25),
          ('gap',  'chatbot',     'No Live Chat / WhatsApp',  5, true,  26),
          ('gap',  'ssl',         'No HTTPS / Secure Site',   5, true,  27)
        ON CONFLICT (key) DO NOTHING;
      `);
      console.log('  ✅ Score config seeded');
    }

    // Safe migration: add columns that may be missing from older DB instances
    await pool.query(`
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS base_score     NUMERIC     DEFAULT 0;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS final_score    NUMERIC     DEFAULT 0;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS score          INTEGER     DEFAULT 0;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS website_status TEXT;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS gaps_found     JSONB;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS priority       TEXT;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS pitch          TEXT;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS scored_at      TIMESTAMPTZ;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS search_query   TEXT;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS missing_services TEXT;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales_pitch    TEXT;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS domain         TEXT DEFAULT 'school';
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS size           TEXT DEFAULT 'small';
    `);

    // ── Domains table ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS domains (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        icon TEXT DEFAULT '📋',
        query TEXT NOT NULL,
        target_term TEXT DEFAULT 'customers',
        type_term TEXT DEFAULT 'business',
        created_by TEXT DEFAULT 'Admin',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS target_term TEXT DEFAULT 'customers';
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS type_term TEXT DEFAULT 'business';
    `);
    const domCount = await pool.query('SELECT COUNT(*) FROM domains');
    if (parseInt(domCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO domains (name, label, icon, query, target_term, type_term, created_by) 
        VALUES 
          ('school', 'Schools', 'school', 'Preschools in Bengaluru', 'parents', 'admissions', 'System'),
          ('gym', 'Gyms', 'dumbbell', 'Gyms in Bengaluru', 'potential members', 'memberships', 'System'),
          ('manufacturing', 'Manufacturing', 'factory', 'Manufacturing companies in Bengaluru', 'potential clients', 'deals', 'System'),
          ('hospital', 'Hospitals', 'hospital', 'Hospitals in Bengaluru', 'patients', 'consultations', 'System'),
          ('salon', 'Salons', 'scissors', 'Salons in Bengaluru', 'new clients', 'bookings', 'System')
        ON CONFLICT DO NOTHING;
      `);
      console.log('  ✅ Default domains seeded');
    }

    // Safe migration for Reminders (rename note to message if exists)
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reminders' AND column_name='note') THEN
          ALTER TABLE reminders RENAME COLUMN note TO message;
        END IF;
      END $$;
    `);

    // ── Safe migrations (add columns if missing) ──
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='team' AND column_name='territory') THEN
          ALTER TABLE team ADD COLUMN territory TEXT DEFAULT '';
        END IF;
      END $$;
    `);

    // Optional bootstrap admin. Never create known credentials automatically.
    if (process.env.SEED_DEFAULT_ADMIN === 'true') {
      const adminEmail = process.env.DEFAULT_ADMIN_EMAIL;
      const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD;
      if (!adminEmail || !adminPassword || adminPassword.length < 12) {
        throw new Error('DEFAULT_ADMIN_EMAIL and a 12+ character DEFAULT_ADMIN_PASSWORD are required when SEED_DEFAULT_ADMIN=true');
      }
      const adminCheck = await pool.query('SELECT id FROM users WHERE email=$1', [adminEmail.toLowerCase().trim()]);
      if (adminCheck.rows.length === 0) {
        const hash = await bcrypt.hash(adminPassword, 10);
        await pool.query(
          `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
          [process.env.DEFAULT_ADMIN_NAME || 'Admin User', adminEmail.toLowerCase().trim(), hash, 'admin']
        );
        console.log('✅ Bootstrap admin created');
      }
    }

    console.log('✅ Connected to PostgreSQL —', process.env.DATABASE_URL.split('/').pop());
    console.log('✅ Tables ready!');
  } catch (err) {
    console.error('❌ Database setup failed:', err.message);
  }
}

if (process.env.AUTO_INIT_DB !== 'false' && !isProduction) {
  initDB();
} else {
  console.log('ℹ️ Automatic database initialization is disabled');
}

// ── AUTH MIDDLEWARE ──
function requireAuth(roles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: 'No token provided' });
    const token = header.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    } catch (e) {
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}

// Resolves the caller's organization from organization_memberships,
// falling back to the seeded default org (every pre-existing user was
// backfilled into it by migration 001, so this only matters for brand new
// accounts created before a membership exists).
async function getOrgId(userId) {
  const { rows } = await pool.query(
    `SELECT org_id FROM organization_memberships WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );
  return rows[0]?.org_id || DEFAULT_ORG_ID;
}

// ── ROOT & HEALTH ──
app.get('/api/', (req, res) => {
  res.json({ status: 'ok', message: 'LeadForge server running' });
});

// ── AUTH ROUTES ──
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  console.log(`🔑 Login attempt: ${email}`);
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!result.rows.length) {
      console.log(`❌ Login failed: User not found (${email})`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    // Access is a projection of Nomi's directory: the hourly sync stamps
    // disabled_at on anyone Nomi no longer lists, and they lose the CRM
    // with it. The row is kept so their past activity stays attributable.
    if (user.disabled_at) {
      console.log(`❌ Login failed: account disabled (${email})`);
      return res.status(403).json({ error: 'This account is no longer active. Contact an administrator.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      console.log(`❌ Login failed: Invalid password for ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role, team_id: user.team_id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    console.log(`✅ Login success: ${email} (${user.role})`);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, team_id: user.team_id, territory: user.territory } });
  } catch (err) {
    console.error(`❌ Login error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
  res.json({ user: req.user });
});

// Name, email and password all live in Nomi and are overwritten by every
// sync, so editing them here would appear to work and then silently revert.
// The endpoint says so rather than pretending to save.
app.put('/api/auth/update', requireAuth(), async (req, res) => {
  res.status(405).json({
    error: 'Your name, email and password are managed in Nomi. Change them there and they will update here within the hour.'
  });
});

// Accounts are created in Nomi, never here.
// The CRM holds a read-only projection of Nomi's user directory
// (scripts/sync-nomi-users.js). Allowing a second creation path would let
// the two drift: a user made here would have no Nomi identity, no
// nomi_user_id, and no role Nomi could correct.
app.post('/api/auth/register', requireAuth(['admin']), async (req, res) => {
  res.status(405).json({
    error: 'Accounts are managed in Nomi. Add the person in Nomi and they will appear here within the hour.'
  });
});

// Every remaining API route requires a valid signed-in user.
app.use('/api', requireAuth());

// ── Helpers ────────────────────────────────────────────
function cleanPhone(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Remove leading single quote (from Excel imports)
  s = s.replace(/^[']+/, '').trim();
  // Filter out literal garbage strings
  if (/^(undefined|null|none|nan|#ERROR!|#N\/A|#VALUE!|#REF!|#NAME\?|#DIV\/0!|#NULL!)$/i.test(s)) return '';
  return s;
}

function detectDomain(name, existingDomain) {
  const n = (name || '').toLowerCase();

  if (n.includes('hospital') || n.includes('clinic') ||
    n.includes('medical') || n.includes('surgical') ||
    n.includes('diagnostic') || n.includes('fortis') ||
    n.includes('apollo') || n.includes('manipal') ||
    n.includes('narayana'))
    return 'hospital';

  if (n.includes('gym') || n.includes('fitness') ||
    n.includes('crossfit') || n.includes('workout') ||
    n.includes('cult fit') || n.includes('bodybuilding'))
    return 'gym';

  if (n.includes('restaurant') || n.includes('cafe') ||
    n.includes('dhaba') || n.includes('eatery') ||
    n.includes('kitchen') || n.includes('bistro'))
    return 'restaurant';

  if (n.includes('software') || n.includes('technologies') ||
    n.includes('solutions') || n.includes('systems') ||
    n.includes('infosys'))
    return 'it';

  return existingDomain || 'school';
}
function calcBaseScore({ rating, reviews, phone, website, address }) {
  let score = 0;
  const r = parseFloat(rating) || 0;
  if (r >= 4.5) score += 25; else if (r >= 4.0) score += 20; else if (r >= 3.5) score += 14; else if (r >= 3.0) score += 8; else if (r > 0) score += 4;
  const rv = parseInt(reviews) || 0;
  if (rv >= 200) score += 20; else if (rv >= 100) score += 16; else if (rv >= 50) score += 12; else if (rv >= 20) score += 8; else if (rv >= 5) score += 4;
  if (phone) score += 10;
  if (website) score += 15;
  if (address) score += 10;
  return Math.min(score, 80);
}

// ── Score Config API ─────────────────────────────────
app.get('/api/score-config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM score_config ORDER BY sort_order ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/score-config/:id', requireAuth(['admin']), async (req, res) => {
  const { points, enabled } = req.body;
  const updates = []; const vals = []; let i = 1;
  if (points !== undefined) { updates.push(`points=$${i++}`); vals.push(parseInt(points)); }
  if (enabled !== undefined) { updates.push(`enabled=$${i++}`); vals.push(Boolean(enabled)); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  updates.push(`updated_at=NOW()`); vals.push(req.params.id);
  try {
    const r = await pool.query(`UPDATE score_config SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, vals);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LEADS ──
app.get('/api/leads', async (req, res) => {
  const { domain, size, city, area, normalized_location, campaign_id } = req.query;
  try {
    let q = 'SELECT * FROM leads WHERE 1=1';
    let params = [];
    if (domain && domain !== 'all') {
      params.push(domain);
      q += ` AND domain = $${params.length}`;
    }
    if (size && size !== 'all') {
      params.push(size);
      q += ` AND size = $${params.length}`;
    }
    if (city && city !== 'all') {
      params.push(`%${city.toLowerCase()}%`);
      q += ` AND (LOWER(city) LIKE $${params.length} OR LOWER(area) LIKE $${params.length} OR LOWER(normalized_location) LIKE $${params.length})`;
    }
    if (area && area !== 'all') {
      params.push(`%${area.toLowerCase()}%`);
      q += ` AND LOWER(area) LIKE $${params.length}`;
    }
    if (normalized_location) {
      params.push(`%${normalized_location.toLowerCase()}%`);
      q += ` AND LOWER(normalized_location) LIKE $${params.length}`;
    }
    if (campaign_id) {
      params.push(campaign_id);
      q += ` AND EXISTS (SELECT 1 FROM source_records sr WHERE sr.legacy_lead_id = leads.id AND sr.campaign_id = $${params.length})`;
    }
    q += ' ORDER BY school_name ASC';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leads/export', async (req, res) => {
  const { domain, segment } = req.query;
  try {
    let q = 'SELECT * FROM leads WHERE 1=1';
    let params = [];
    if (domain && domain !== 'all') {
      params.push(domain);
      q += ` AND domain = $${params.length}`;
    }
    q += ' ORDER BY school_name ASC';
    const result = await pool.query(q, params);
    
    if (!result.rows.length) {
      return res.status(404).json({ error: 'No leads found to export' });
    }

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(result.rows);
    
    const dateStr = new Date().toISOString().split('T')[0];
    const segmentStr = segment ? `${segment}.` : 'leads.';
    const domainStr = domain && domain !== 'all' ? domain : 'all';
    const fileName = `${segmentStr}${domainStr}.${dateStr}.csv`;
    
    res.header('Content-Type', 'text/csv');
    res.attachment(fileName);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DOMAINS API ──
app.get('/api/domains', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM domains ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/domains/:name', requireAuth(['admin']), async (req, res) => {
  const { name } = req.params;
  const { label, icon, target_term, type_term } = req.body;
  try {
    const result = await pool.query(
      `UPDATE domains SET label = COALESCE($1, label), icon = COALESCE($2, icon), target_term = COALESCE($3, target_term), type_term = COALESCE($4, type_term)
       WHERE name = $5 RETURNING *`,
      [label, icon, target_term, type_term, name]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sector not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Creating a sector is the first step of the lead-generation flow, which
// salespeople now run themselves — so this is open to them. PATCH and
// DELETE below stay admin-only: renaming or removing a sector affects
// every user's data, whereas adding one is purely additive.
app.post('/api/domains', requireAuth(['admin', 'salesperson']), async (req, res) => {
  const { name, label, icon, query, created_by, target_term, type_term } = req.body;
  try {
    const exists = await pool.query('SELECT id FROM domains WHERE name = $1', [name]);
    if (exists.rows.length > 0) return res.json({ exists: true });

    const result = await pool.query(
      'INSERT INTO domains (name, label, icon, query, created_by, target_term, type_term) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [name, label, icon, query, created_by || 'Admin', target_term || 'customers', type_term || 'business']
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/domains/:name', requireAuth(['admin']), async (req, res) => {
  const { name } = req.params;
  if (name === 'school') return res.status(400).json({ error: 'Cannot delete the base Schools sector' });
  try {
    const result = await pool.query('DELETE FROM domains WHERE name = $1 RETURNING *', [name]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Sector not found' });

    // Also delete leads associated with this domain
    const leadCount = await pool.query('DELETE FROM leads WHERE domain = $1', [name]);

    console.log(`🗑️ Deleted sector: ${name} and ${leadCount.rowCount} associated leads`);
    res.json({ success: true, message: `Sector '${name}' and its leads deleted successfully.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leads/brand-stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
       LOWER(SPLIT_PART(school_name, ' ', 1)) as brand_token,
       LOWER(SPLIT_PART(school_name, ' ', 2)) as brand_token2,
       COUNT(*) as location_count,
       AVG(CAST(rating AS FLOAT)) as avg_rating,
       SUM(COALESCE(reviews, 0)) as total_reviews,
       domain
      FROM leads
      GROUP BY 
       LOWER(SPLIT_PART(school_name, ' ', 1)),
       LOWER(SPLIT_PART(school_name, ' ', 2)),
       domain
      ORDER BY location_count DESC;
    `);

    // A brand is classified as "Big Brand" if:
    // - location_count >= 3 (appears 3+ times = chain)
    // - OR avg_rating >= 4.7
    // - OR total_reviews >= 500
    const bigBrands = new Set();
    result.rows.forEach(row => {
      const isChain = parseInt(row.location_count) >= 3;
      const isHighRated = parseFloat(row.avg_rating) >= 4.7;
      const isBigVolume = parseInt(row.total_reviews) >= 500;

      if (isChain || isHighRated || isBigVolume) {
        if (row.brand_token) bigBrands.add(row.brand_token);
        // Also add the combined first two words if it's a multi-word brand
        if (row.brand_token && row.brand_token2) {
          bigBrands.add(`${row.brand_token} ${row.brand_token2}`);
        }
      }
    });

    res.json({
      bigBrands: Array.from(bigBrands),
      threshold: {
        minLocations: 3,
        minRating: 4.7,
        minReviews: 500
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/mine', requireAuth(['salesperson']), async (req, res) => {
  try {
    const teamId = req.user.team_id;
    const result = await pool.query(
      'SELECT * FROM leads WHERE assigned_id=$1 ORDER BY school_name ASC',
      [teamId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads', async (req, res) => {
  const { school_name, address, phone, website, rating, reviews, source, status, assigned_id, notes, deal_value, domain, city, area, state, country } = req.body;
  try {
    const cleanedPhone = cleanPhone(phone);
    const finalDomain = detectDomain(school_name, domain);
    const base = calcBaseScore({ rating, reviews, phone: cleanedPhone, website, address });
    const normalizedLocation = normalizeLocation({ area, city, state, country });
    const result = await pool.query(
      `INSERT INTO leads (school_name, address, phone, website, rating, reviews, base_score, score, source, status, assigned_id, notes, deal_value, domain, city, area, state, country, normalized_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [school_name, address, cleanedPhone, website, rating || null, reviews || null, base, base, source || 'manual', status || 'new', assigned_id || null, notes || '', deal_value || 0, finalDomain, city || null, area || null, state || null, country || null, normalizedLocation]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  const fields = req.body;
  try {
    const keys = Object.keys(fields);
    if (!keys.length) return res.status(400).json({ error: 'No fields to update' });
    const allowedFields = new Set(['school_name', 'address', 'phone', 'website', 'rating', 'reviews', 'status', 'assigned_id', 'notes', 'deal_value', 'domain', 'size', 'city', 'area', 'state', 'country']);
    const invalidFields = keys.filter((key) => !allowedFields.has(key));
    if (invalidFields.length) return res.status(400).json({ error: `Unsupported fields: ${invalidFields.join(', ')}` });
    const setClause = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
    const values = keys.map(k => fields[k]);
    values.push(id);
    const result = await pool.query(
      `UPDATE leads SET ${setClause} WHERE id=$${values.length} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/leads/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  try {
    const result = await pool.query(
      'UPDATE leads SET status=$1 WHERE id=$2 RETURNING *',
      [status, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Lead not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/leads/:id', requireAuth(['admin']), async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/assign', async (req, res) => {
  const { lead_ids, team_id } = req.body;
  if (!lead_ids || !lead_ids.length) return res.status(400).json({ error: 'lead_ids required' });
  try {
    await pool.query(
      `UPDATE leads SET assigned_id=$1, assigned_at=NOW() WHERE id = ANY($2::int[])`,
      [team_id, lead_ids]
    );
    res.json({ success: true, updated: lead_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/dedup', requireAuth(['admin']), async (req, res) => {
  try {
    const r1 = await pool.query(`
      DELETE FROM leads a USING leads b
      WHERE a.id > b.id 
      AND a.school_name = b.school_name 
      AND (a.address = b.address OR (a.address IS NULL AND b.address IS NULL))
    `);
    const r2 = await pool.query(`
      DELETE FROM leads a USING leads b
      WHERE a.id > b.id 
      AND a.school_name = b.school_name 
      AND (a.phone = b.phone OR (a.phone IS NULL AND b.phone IS NULL))
    `);
    res.json({ success: true, removed: r1.rowCount + r2.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TEAM ──
app.get('/api/team', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM team ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/team', requireAuth(['admin']), async (req, res) => {
  const { name, role, email, phone, color, status, territory } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO team (name, role, email, phone, color, status, territory) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, role, email || '', phone || '', color || '#5b6af7', status || 'online', territory || '']
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/team/:id', requireAuth(['admin']), async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('UPDATE leads SET assigned_id = NULL WHERE assigned_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE team_id = $1', [id]);
    await pool.query('DELETE FROM team WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── n8n WEBHOOK ──────────────────────────────────────────────
app.post('/webhook/leads', (req, res, next) => {
  const expected = process.env.N8N_WEBHOOK_SECRET;
  const supplied = req.headers['x-webhook-secret'];
  if (!expected) {
    if (isProduction) return res.status(503).json({ error: 'Webhook is not configured' });
    return next();
  }
  if (supplied !== expected) return res.status(401).json({ error: 'Invalid webhook secret' });
  next();
}, async (req, res) => {
  const { school_name, address, phone, website, rating, reviews, domain, city, area, state, country } = req.body;
  try {
    const cleanedPhone = cleanPhone(phone);
    const base = calcBaseScore({ rating, reviews, phone: cleanedPhone, website, address });

    // Auto-tag big vs small
    let size = 'small';
    if (parseInt(reviews) > 500) size = 'big';
    const bigNames = ['apollo', 'fortis', 'sparsh', 'manipal', 'cult.fit', 'gold\'s gym', 'lakme', 'naturals', 'dps', 'podar', 'tata', 'wipro'];
    const lowerName = (school_name || '').toLowerCase();
    if (bigNames.some(bn => lowerName.includes(bn))) size = 'big';

    const finalDomain = detectDomain(school_name, domain || global.lastN8nDomain || 'school');
    // n8n workflows don't always echo location fields back on the inbound
    // webhook, so fall back to whatever the outbound /api/trigger-n8n call
    // most recently sent — same pattern as global.lastN8nDomain above.
    const loc = {
      city: city || global.lastN8nLocation.city || null,
      area: area || global.lastN8nLocation.area || null,
      state: state || global.lastN8nLocation.state || null,
      country: country || global.lastN8nLocation.country || null,
    };
    const normalizedLocation = normalizeLocation(loc);

    const result = await pool.query(
      `INSERT INTO leads (school_name, address, phone, website, rating, reviews, base_score, score, source, status, domain, size, city, area, state, country, normalized_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'n8n','new',$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [school_name || 'Unknown', address || '', cleanedPhone, website || '', rating || null, reviews || null, base, base, finalDomain, size, loc.city, loc.area, loc.state, loc.country, normalizedLocation]
    );
    if (!result.rows.length) {
      return res.json({ success: true, skipped: true, message: 'Duplicate lead, skipped.' });
    }
    console.log('⚡ New lead from n8n:', school_name, '| size:', size, '| base_score:', base);
    res.json({ success: true, lead: result.rows[0] });

    // Best-effort provenance record for the new collection framework.
    // Fire-and-forget: never blocks or affects the webhook response above,
    // and is silently skipped pre-migration (source_records not present yet).
    pool.query(
      `INSERT INTO source_records (id, org_id, source_type, external_ref, raw_payload, legacy_lead_id, status)
       VALUES ($1,$2,'n8n',$3,$4,$5,'collected')`,
      [crypto.randomUUID(), DEFAULT_ORG_ID, String(result.rows[0].id), JSON.stringify(req.body), result.rows[0].id]
    ).catch(() => { /* pre-migration or table missing — non-fatal */ });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── OUTREACH DELIVERY/REPLY WEBHOOK (Phase 5) ─────────────────
// Generic inbound event receiver for whichever email/WhatsApp provider is
// configured — matches an outreach_messages row by provider_message_id.
// Same shared-secret gating pattern as /webhook/leads: required in
// production, optionally open in dev if no secret is set.
app.post('/webhook/outreach', (req, res, next) => {
  const expected = process.env.OUTREACH_WEBHOOK_SECRET;
  const supplied = req.headers['x-webhook-secret'];
  if (!expected) {
    if (isProduction) return res.status(503).json({ error: 'Webhook is not configured' });
    return next();
  }
  if (supplied !== expected) return res.status(401).json({ error: 'Invalid webhook secret' });
  next();
}, async (req, res) => {
  const { provider_message_id, event, error } = req.body;
  if (!provider_message_id || !['delivered', 'replied', 'failed'].includes(event)) {
    return res.status(400).json({ error: 'provider_message_id and a valid event are required' });
  }
  try {
    const columnByEvent = { delivered: 'delivered_at', replied: 'replied_at', failed: null };
    const setClause = columnByEvent[event] ? `${columnByEvent[event]}=NOW(), status=$1` : `status=$1, error=$2`;
    const values = columnByEvent[event] ? [event, provider_message_id] : [event, error || null, provider_message_id];
    const { rows } = await pool.query(
      `UPDATE outreach_messages SET ${setClause} WHERE provider_message_id=$${values.length} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'No message found for this provider_message_id' });
    const message = rows[0];
    await recordActivity(pool, { org_id: message.org_id, type: `outreach_${message.channel}_${event}`, company_id: message.company_id, contact_id: message.contact_id, opportunity_id: message.opportunity_id, payload: { message_id: message.id } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Re-score a single lead on demand ─────────────────────────
app.post('/api/leads/:id/score', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
    const scored = await scoreLead(rows[0]);
    res.json({ success: true, lead: scored });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CALL LOGS ─────────────────────────────────────────
app.post('/api/leads/:id/calls', async (req, res) => {
  const { id } = req.params;
  let { called_by, duration, outcome, notes, next_followup } = req.body;
  if (!called_by || called_by === 'undefined' || called_by === 'null') called_by = 'Unknown';
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO call_logs (lead_id, called_by, duration, outcome, notes, next_followup)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, called_by, duration || 0, outcome || 'no_answer', notes || '', next_followup || null]
      );
      const newCall = result.rows[0];

      // If there's a follow-up, create a reminder automatically
      if (next_followup) {
        // Fetch lead school name for the note
        const leadRes = await client.query('SELECT school_name FROM leads WHERE id=$1', [id]);
        const schoolName = leadRes.rows[0]?.school_name || 'Prospect';

        // Set reminder time to 09:00 AM on that day
        const remindAt = new Date(next_followup);
        remindAt.setHours(9, 0, 0, 0);

        const outcomeLabel = { interested: 'Interested', callback: 'Call Back', no_answer: 'No Answer', voicemail: 'Left Voicemail', not_interested: 'Not Interested', closed: 'Deal Closed!' }[outcome] || outcome;
        const msg = `Follow up with ${schoolName} - outcome: ${outcomeLabel}`;

        await client.query(
          `INSERT INTO reminders (lead_id, call_log_id, remind_at, message, created_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, newCall.id, remindAt, msg, called_by]
        );
      }

      await client.query('COMMIT');
      res.json(newCall);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/leads/:id/calls', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM call_logs WHERE lead_id=$1 ORDER BY called_at DESC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/leads/:id/calls/:callId', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM call_logs WHERE id=$1 AND lead_id=$2 RETURNING id', [req.params.callId, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Call log not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/activity', async (req, res) => {
  try {
    const result = await pool.query(`
      (SELECT 
        id, lead_id, called_by as added_by, called_at as created_at, 
        'call' as type, outcome, duration, notes, next_followup 
       FROM call_logs)
      UNION ALL
      (SELECT 
        id, lead_id, added_by, created_at, 
        'note' as type, NULL as outcome, NULL as duration, note as notes, NULL as next_followup 
       FROM lead_notes)
      UNION ALL
      (SELECT 
        id, lead_id, created_by as added_by, created_at, 
        'reminder' as type, status as outcome, NULL as duration, message as notes, remind_at as next_followup 
       FROM reminders)
      ORDER BY created_at DESC 
      LIMIT 30
    `);

    // Fetch school names and statuses for these activities
    const activities = result.rows;
    if (activities.length === 0) return res.json([]);

    const leadIds = [...new Set(activities.map(a => a.lead_id))];
    const leadsResult = await pool.query('SELECT id, school_name, status FROM leads WHERE id = ANY($1)', [leadIds]);
    const leadMap = {};
    leadsResult.rows.forEach(l => leadMap[l.id] = { school_name: l.school_name, status: l.status });

    res.json(activities.map(a => ({
      ...a,
      school_name: leadMap[a.lead_id]?.school_name || 'Unknown School',
      lead_status: leadMap[a.lead_id]?.status || ''
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LEAD NOTES ─────────────────────────────────────────
app.post('/api/leads/:id/notes', async (req, res) => {
  const { id } = req.params;
  let { added_by, note } = req.body;
  if (!added_by || added_by === 'undefined') added_by = 'Unknown';
  if (!note) return res.status(400).json({ error: 'note is required' });
  try {
    const result = await pool.query(`INSERT INTO lead_notes (lead_id, added_by, note) VALUES ($1,$2,$3) RETURNING *`, [id, added_by, note]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/leads/:id/notes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM lead_notes WHERE lead_id=$1 ORDER BY created_at DESC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/leads/:id/notes/:noteId', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM lead_notes WHERE id=$1 AND lead_id=$2 RETURNING id', [req.params.noteId, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Note not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REMINDERS ─────────────────────────────────────────
app.post('/api/reminders', async (req, res) => {
  const { lead_id, call_log_id, remind_at, message, created_by } = req.body;
  if (!lead_id || !remind_at) return res.status(400).json({ error: 'lead_id and remind_at required' });
  const by = (!created_by || created_by === 'undefined') ? 'Unknown' : created_by;
  try {
    const result = await pool.query(
      `INSERT INTO reminders (lead_id, call_log_id, remind_at, message, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [lead_id, call_log_id || null, remind_at, message || '', by]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reminders/today', async (req, res, next) => {
  // Allow n8n bypass if coming via ngrok with explicit header (or you can add a secret key check)
  if (req.headers['ngrok-skip-browser-warning'] === 'true') {
    req.user = { role: 'admin' };
    return next();
  }
  requireAuth(['admin', 'salesperson'])(req, res, next);
}, async (req, res) => {
  try {
    const isN8n = req.headers['ngrok-skip-browser-warning'] === 'true';
    let where = `WHERE DATE(reminders.remind_at) <= CURRENT_DATE AND (reminders.status IS NULL OR reminders.status = 'pending')`;
    if (isN8n) {
      where += ` AND reminders.remind_at <= NOW()`;
    }

    let params = [];
    if (req.user && req.user.role === 'salesperson') {
      params.push(req.user.team_id);
      where += ` AND leads.assigned_id = $${params.length}`;
    }

    const result = await pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (leads.school_name, DATE_TRUNC('minute', reminders.remind_at), reminders.message)
               reminders.*, leads.school_name, leads.phone,
               COALESCE(team.email, u.email) AS rep_email, 
               COALESCE(team.name, u.name, reminders.created_by) AS rep_name,
               reminders.message AS note
        FROM reminders
        LEFT JOIN leads ON reminders.lead_id = leads.id
        LEFT JOIN team ON leads.assigned_id = team.id
        LEFT JOIN users u ON LOWER(reminders.created_by) = LOWER(u.name)
        ${where}
        ORDER BY leads.school_name, DATE_TRUNC('minute', reminders.remind_at), reminders.message, reminders.id ASC
      ) t
      ORDER BY remind_at ASC
    `, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reminders/upcoming', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, 
             l.school_name, 
             l.phone,
             u.email as rep_email,
             u.name as rep_name
      FROM reminders r
      JOIN leads l ON r.lead_id = l.id
      LEFT JOIN users u ON LOWER(r.created_by) = LOWER(u.name)
      WHERE r.remind_at >= NOW() 
      AND r.remind_at <= NOW() + INTERVAL '7 days'
      AND r.status = 'pending'
      ORDER BY r.remind_at ASC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reminders/by-rep/:email', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, 
             l.school_name, 
             l.phone,
             u.email as rep_email,
             u.name as rep_name
      FROM reminders r
      JOIN leads l ON r.lead_id = l.id
      LEFT JOIN users u ON LOWER(r.created_by) = LOWER(u.name)
      WHERE u.email = $1
      AND r.status = 'pending'
      ORDER BY r.remind_at ASC
    `, [req.params.email]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/reminders/:id', async (req, res) => {
  const { status } = req.body;
  if (!['done', 'dismissed'].includes(status)) return res.status(400).json({ error: 'status must be done or dismissed' });
  try {
    const result = await pool.query(`UPDATE reminders SET status=$1 WHERE id=$2 RETURNING *`, [status, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/reminders/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reminders WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leads/:id/reminders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reminders WHERE lead_id=$1 ORDER BY remind_at ASC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fix corrupted data ──────────────────────────────
app.post('/api/fix-data', requireAuth(['admin']), async (req, res) => {
  try {
    const corrupted = ['undefined', 'null', 'none', 'NaN', '#ERROR!', '#N/A'];
    let totalFixed = 0;

    // Fix phones
    const r1 = await pool.query(`
      UPDATE leads 
      SET phone = '' 
      WHERE phone IS NULL 
         OR TRIM(LOWER(phone)) = ANY($1) 
         OR phone ~* '^#(ERROR|N\/A|VALUE|REF|NAME|DIV/0|NULL)'
      RETURNING id
    `, [corrupted]);
    totalFixed += r1.rowCount;

    // Fix school names
    const r2 = await pool.query(`
      UPDATE leads 
      SET school_name = 'Unknown School' 
      WHERE school_name IS NULL OR TRIM(LOWER(school_name)) = ANY($1)
      RETURNING id
    `, [corrupted]);
    totalFixed += r2.rowCount;

    // Fix call logs
    const r3 = await pool.query(`
      UPDATE call_logs 
      SET called_by = 'Unknown' 
      WHERE called_by IS NULL OR TRIM(LOWER(called_by)) = ANY($1)
      RETURNING id
    `, [corrupted]);
    totalFixed += r3.rowCount;

    // Fix lead notes
    const r4 = await pool.query(`
      UPDATE lead_notes 
      SET added_by = 'Unknown' 
      WHERE added_by IS NULL OR TRIM(LOWER(added_by)) = ANY($1)
      RETURNING id
    `, [corrupted]);
    totalFixed += r4.rowCount;

    res.json({ success: true, fixed_count: totalFixed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fix corrupted phone data ─────────────────────────────
app.post('/api/fix-phones', requireAuth(['admin']), async (req, res) => {
  try {
    const result = await pool.query(`UPDATE leads SET phone='' WHERE phone ~* '^#(ERROR|N\/A|VALUE|REF|NAME|DIV/0|NULL)' RETURNING id, school_name`);
    res.json({ success: true, fixed: result.rowCount, leads: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Scrape trigger ────────────────────────────────────────────
app.post('/api/trigger-scrape', async (req, res) => {
  const query = req.body?.query || process.env.N8N_QUERY || 'preschools in Bengaluru';
  try {
    const domain = req.body?.domain || 'school';
    const { city, area, state, country, min_leads, max_leads } = req.body || {};
    const orgId = await getOrgId(req.user.id);
    console.log(`\n⚡ Scrape triggered for: "${query}" (domain: ${domain}${city || area ? `, location: ${area || ''}${area && city ? ', ' : ''}${city || ''}` : ''})`);
    const results = await scrapeAndSave(query, domain, { city, area, state, country }, orgId, min_leads, max_leads);
    res.json({
      success: true, query, domain,
      saved: results.saved.length, skipped: results.skipped.length, rejected: results.rejected.length, errors: results.errors.length,
      leads: results.saved, campaign_id: results.campaign_id, run_id: results.run_id,
    });
  } catch (err) {
    console.error('Scrape trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Score trigger ─────────────────────────────────────────────
app.post('/api/trigger-score', async (req, res) => {
  try {
    console.log('\n⚡ Score trigger received');
    const scored = await scoreAllPendingLeads();
    res.json({ success: true, scored: scored.length });
  } catch (err) {
    console.error('Score trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Full pipeline: Scrape → Score ─────────────────────────────
app.post('/api/trigger-all', async (req, res) => {
  const query = req.body?.query || process.env.N8N_QUERY || 'preschools in Bengaluru';
  try {
    const domain = req.body?.domain || 'school';
    const { city, area, state, country, min_leads, max_leads } = req.body || {};
    const orgId = await getOrgId(req.user.id);
    console.log(`\n🚀 FULL PIPELINE triggered for: "${query}" (domain: ${domain}) by ${req.user.email}`);
    const scrapeResults = await scrapeAndSave(query, domain, { city, area, state, country }, orgId, min_leads, max_leads);

    // A salesperson owns what they source: the leads they just generated are
    // assigned to them, so they appear in "My Leads" without an admin having
    // to hand them over. Admins are left out on purpose — their generated
    // leads stay in the unassigned pool for the existing distribution flow.
    let autoAssigned = 0;
    if (req.user.role !== 'admin' && scrapeResults.saved.length) {
      const { rows: me } = await pool.query('SELECT team_id FROM users WHERE id=$1', [req.user.id]);
      const teamId = me[0]?.team_id;
      if (teamId) {
        const ids = scrapeResults.saved.map((l) => l.id);
        const { rowCount } = await pool.query(
          `UPDATE leads SET assigned_id=$1, assigned_at=NOW()
            WHERE id = ANY($2::int[]) AND assigned_id IS NULL`,
          [teamId, ids]
        );
        autoAssigned = rowCount;
        console.log(`👤 Auto-assigned ${autoAssigned} new lead(s) to ${req.user.email}`);
      } else {
        console.warn(`⚠️ ${req.user.email} has no team row — generated leads left unassigned`);
      }
    }

    const scored = await scoreAllPendingLeads();
    const { rows: allLeads } = await pool.query(
      `SELECT id, school_name, score, priority, website_status, gaps_found FROM leads WHERE search_query=$1 ORDER BY score DESC`,
      [query]
    );
    res.json({
      success: true, query,
      pipeline: {
        scraped: scrapeResults.saved.length, skipped: scrapeResults.skipped.length,
        rejected: scrapeResults.rejected.length, errors: scrapeResults.errors.length, scored: scored.length,
        assigned: autoAssigned,
        // Kept, but outside the exact neighbourhood asked for.
        outside_area: (scrapeResults.outsideArea || []).length,
      },
      leads: allLeads, campaign_id: scrapeResults.campaign_id, run_id: scrapeResults.run_id,
    });
  } catch (err) {
    console.error('Pipeline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stats summary ─────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [total, byStatus, byPriority, avgScore, byDomain, remindersToday] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM leads'),
      pool.query('SELECT status, COUNT(*) FROM leads GROUP BY status'),
      pool.query('SELECT priority, COUNT(*) FROM leads WHERE priority IS NOT NULL GROUP BY priority'),
      pool.query('SELECT AVG(score)::numeric(5,1) as avg_score FROM leads WHERE score > 0'),
      pool.query("SELECT COALESCE(domain, 'school') as domain, COUNT(*) FROM leads GROUP BY domain"),
      pool.query(`
        SELECT COUNT(*) FROM (
          SELECT DISTINCT lead_id, DATE_TRUNC('minute', remind_at), message FROM reminders 
          WHERE DATE(remind_at) <= CURRENT_DATE AND (status IS NULL OR status = 'pending')
        ) t
      `)
    ]);
    res.json({
      total: parseInt(total.rows[0].count),
      by_status: byStatus.rows,
      by_priority: byPriority.rows,
      avg_score: avgScore.rows[0]?.avg_score || 0,
      by_domain: byDomain.rows,
      reminders_today: parseInt(remindersToday.rows[0].count)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Trigger n8n (proxy) ──────────────────────────────────────
app.post('/api/trigger-n8n', requireAuth(['admin', 'salesperson']), async (req, res) => {
  const { generated_by_name, custom_query, domain, city, area, state, country } = req.body;
  if (!city || !city.trim()) {
    return res.status(400).json({ error: 'Please enter the city or pincode' });
  }
  if (generated_by_name) global.lastN8nTrigger = generated_by_name;
  if (domain) global.lastN8nDomain = domain;
  if (city || area || state || country) global.lastN8nLocation = { city: city || null, area: area || null, state: state || null, country: country || null };

  try {
    let target_term = 'customers';
    let type_term = 'business';

    if (domain) {
      const { rows } = await pool.query('SELECT target_term, type_term FROM domains WHERE name = $1', [domain]);
      if (rows.length > 0) {
        target_term = rows[0].target_term || 'customers';
        type_term = rows[0].type_term || 'business';
      }
    }

    const rawQuery = custom_query || process.env.N8N_QUERY;
    const locationAwareQuery = combineQueryWithLocation(rawQuery, { city, area, state, country });

    // n8n is an optional integration. With no webhook configured, say so
    // plainly instead of calling fetch(undefined) and logging "Failed to
    // parse URL from" on every single lead-generation run.
    if (!process.env.N8N_WEBHOOK_URL) {
      return res.json({ skipped: true, reason: 'N8N_WEBHOOK_URL is not configured' });
    }

    const response = await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: locationAwareQuery,
        original_query: rawQuery,
        domain: domain,
        city: city || null,
        area: area || null,
        state: state || null,
        country: country || null,
        target_term: target_term,
        type_term: type_term,
        generated_by: generated_by_name || 'Admin'
      })
    });

    const data = await response.text();
    console.log('⚡ n8n workflow triggered:', data);
    res.json({ success: true, message: 'n8n workflow triggered!' });
  } catch (err) {
    console.error('n8n trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Fix status endpoint ───────────────────────────────────────
app.post('/api/fix-status', requireAuth(['admin']), async (req, res) => {
  try {
    await pool.query(`UPDATE leads SET status = 'new' WHERE status IS NULL OR (TRIM(LOWER(status)) != 'contacted' AND TRIM(LOWER(status)) != 'qualified' AND TRIM(LOWER(status)) != 'closed' AND TRIM(LOWER(status)) != 'scored');`);
    const result = await pool.query('SELECT status, COUNT(*) FROM leads GROUP BY status');
    res.json({ success: true, message: 'All status fixed!', breakdown: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DISCOVERY CAMPAIGNS & COLLECTION FRAMEWORK ─────────────────
// Serper/website runs and CSV imports are enqueued as background jobs
// (lib/jobs) and executed by the in-process worker started below —
// requests return immediately instead of blocking on scraping. Manual
// entry is a single fast write, so it runs synchronously through the
// same collector/company pipeline for consistent provenance.
const RUNNABLE_SOURCE_TYPES = new Set(['serper', 'website']);

app.post('/api/campaigns', async (req, res) => {
  const { name, description, query, source_type, sector, city, area, state, country } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const orgId = await getOrgId(req.user.id);

    // Idempotency guard against duplicate submissions (double-click, retry,
    // two tabs): reuse a just-created campaign with the same name/query/
    // location instead of creating a second one.
    const { rows: recent } = await pool.query(
      `SELECT * FROM discovery_campaigns
       WHERE org_id=$1 AND LOWER(name)=LOWER($2) AND COALESCE(query,'')=COALESCE($3,'')
         AND COALESCE(city,'')=COALESCE($4,'') AND COALESCE(area,'')=COALESCE($5,'')
         AND created_at > NOW() - INTERVAL '60 seconds'
       ORDER BY created_at DESC LIMIT 1`,
      [orgId, name, query || null, city || null, area || null]
    );
    if (recent.length) return res.json({ ...recent[0], deduped: true });

    const normalizedLocation = normalizeLocation({ city, area, state, country });
    const { rows } = await pool.query(
      `INSERT INTO discovery_campaigns (id, org_id, name, description, query, source_type, sector, created_by, city, area, state, country, normalized_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [crypto.randomUUID(), orgId, name, description || null, query || null, source_type || 'manual', sector || null, req.user.id, city || null, area || null, state || null, country || null, normalizedLocation]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/campaigns', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(
      `SELECT * FROM discovery_campaigns WHERE org_id=$1 ORDER BY created_at DESC`,
      [orgId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(
      `SELECT * FROM discovery_campaigns WHERE id=$1 AND org_id=$2`,
      [req.params.id, orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const { rows: runs } = await pool.query(
      `SELECT * FROM campaign_runs WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json({ ...rows[0], runs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/campaigns/:id/runs', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(
      `SELECT r.* FROM campaign_runs r
       JOIN discovery_campaigns c ON c.id = r.campaign_id
       WHERE r.campaign_id=$1 AND c.org_id=$2 ORDER BY r.created_at DESC`,
      [req.params.id, orgId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:id/run', async (req, res) => {
  const { source_type, params } = req.body;
  if (!RUNNABLE_SOURCE_TYPES.has(source_type)) {
    return res.status(400).json({ error: `source_type must be one of: ${[...RUNNABLE_SOURCE_TYPES].join(', ')}` });
  }
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows: campaignRows } = await pool.query(
      `SELECT * FROM discovery_campaigns WHERE id=$1 AND org_id=$2`,
      [req.params.id, orgId]
    );
    if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
    const campaign = campaignRows[0];

    const runId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO campaign_runs (id, org_id, campaign_id, status) VALUES ($1,$2,$3,'pending')`,
      [runId, orgId, campaign.id]
    );
    const job = await enqueueJob(pool, {
      org_id: orgId, campaign_id: campaign.id, run_id: runId, type: source_type,
      payload: {
        query: campaign.query,
        location: { city: campaign.city, area: campaign.area, state: campaign.state, country: campaign.country },
        ...(params || {}),
      },
    });
    await pool.query(`UPDATE campaign_runs SET job_id=$1 WHERE id=$2`, [job.id, runId]);

    res.status(202).json({ success: true, run_id: runId, job_id: job.id, status: 'queued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:id/import-csv', async (req, res) => {
  const { csv_text } = req.body;
  if (!csv_text) return res.status(400).json({ error: 'csv_text is required' });
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows: campaignRows } = await pool.query(
      `SELECT * FROM discovery_campaigns WHERE id=$1 AND org_id=$2`,
      [req.params.id, orgId]
    );
    if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });

    const runId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO campaign_runs (id, org_id, campaign_id, status) VALUES ($1,$2,$3,'pending')`,
      [runId, orgId, req.params.id]
    );
    const job = await enqueueJob(pool, {
      org_id: orgId, campaign_id: req.params.id, run_id: runId, type: 'csv', payload: { csv_text },
    });
    await pool.query(`UPDATE campaign_runs SET job_id=$1 WHERE id=$2`, [job.id, runId]);

    res.status(202).json({ success: true, run_id: runId, job_id: job.id, status: 'queued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:id/manual-entry', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows: campaignRows } = await pool.query(
      `SELECT * FROM discovery_campaigns WHERE id=$1 AND org_id=$2`,
      [req.params.id, orgId]
    );
    if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });

    const { collect } = getCollector('manual');
    const { items, errors } = await collect(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0].message });

    const item = items[0];
    const { company } = await findOrCreateCompany(pool, { org_id: orgId, name: item.company.name, domain: item.company.domain });
    if (item.location?.address_line) {
      await addLocationIfMissing(pool, { org_id: orgId, company_id: company.id, address_line: item.location.address_line });
    }
    let contact = null;
    if (item.contact?.email || item.contact?.phone) {
      contact = await findOrCreateContact(pool, { org_id: orgId, company_id: company.id, ...item.contact });
    }
    await pool.query(
      `INSERT INTO source_records (id, org_id, campaign_id, source_type, external_ref, raw_payload, company_id, contact_id, status)
       VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,'collected')`,
      [crypto.randomUUID(), orgId, req.params.id, item.external_ref, JSON.stringify(item.raw), company.id, contact?.id || null]
    );

    res.json({ success: true, company, contact });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(`SELECT * FROM jobs WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const params = [orgId];
    let q = `SELECT * FROM jobs WHERE org_id=$1`;
    if (req.query.campaign_id) { params.push(req.query.campaign_id); q += ` AND campaign_id=$${params.length}`; }
    q += ` ORDER BY created_at DESC LIMIT 100`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COMPANIES (read) ────────────────────────────────────────────
app.get('/api/companies', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const params = [orgId];
    let q = `SELECT * FROM companies WHERE org_id=$1 AND deleted_at IS NULL`;
    if (req.query.q) { params.push(`%${req.query.q.toLowerCase()}%`); q += ` AND normalized_name LIKE $${params.length}`; }
    q += ` ORDER BY created_at DESC LIMIT 100`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/companies/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(`SELECT * FROM companies WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    const [locations, contacts, opportunities] = await Promise.all([
      pool.query(`SELECT * FROM company_locations WHERE company_id=$1 AND deleted_at IS NULL`, [req.params.id]),
      pool.query(`SELECT * FROM contacts WHERE company_id=$1 AND deleted_at IS NULL`, [req.params.id]),
      pool.query(`SELECT * FROM opportunities WHERE company_id=$1 AND deleted_at IS NULL`, [req.params.id]),
    ]);
    res.json({ ...rows[0], locations: locations.rows, contacts: contacts.rows, opportunities: opportunities.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ENRICHMENT (Phase 3) ────────────────────────────────────────
// Website enrichment runs as a background job (see lib/enrichment) —
// crawling happens off the request thread and is retried on failure like
// any other job.
app.post('/api/companies/:id/enrich', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(`SELECT id FROM companies WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [req.params.id, orgId]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    const job = await enqueueJob(pool, { org_id: orgId, type: 'enrich_company', payload: { company_id: req.params.id } });
    res.status(202).json({ success: true, job_id: job.id, status: 'queued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DEDUPLICATION (Phase 3) ──────────────────────────────────────
// A scan flags duplicate candidates; only exact-domain (company) or
// exact-email (contact) matches auto-merge. Everything else lands in the
// review queue below for a human decision — merges never delete data,
// they redirect child records onto the winner and soft-delete the loser.
app.post('/api/dedup/scan', requireAuth(['admin']), async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const job = await enqueueJob(pool, { org_id: orgId, type: 'dedup_scan', payload: {} });
    res.status(202).json({ success: true, job_id: job.id, status: 'queued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dedup/candidates', requireAuth(['admin']), async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const status = req.query.status || 'pending';
    const { rows } = await pool.query(
      `SELECT * FROM duplicate_candidates WHERE org_id=$1 AND status=$2 ORDER BY confidence DESC, created_at DESC LIMIT 200`,
      [orgId, status]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dedup/candidates/:id/confirm', requireAuth(['admin']), async (req, res) => {
  const { winner_id } = req.body;
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(`SELECT * FROM duplicate_candidates WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!rows.length) return res.status(404).json({ error: 'Candidate not found' });
    const candidate = rows[0];
    if (candidate.status !== 'pending') return res.status(409).json({ error: `Candidate already ${candidate.status}` });

    const idA = candidate.entity_id_a, idB = candidate.entity_id_b;
    const winner = winner_id && [idA, idB].includes(winner_id) ? winner_id : idA;
    const loser = winner === idA ? idB : idA;
    const merge = candidate.entity_type === 'company' ? mergeCompanies : mergeContacts;

    await merge(pool, { org_id: orgId, winner_id: winner, loser_id: loser, confidence: candidate.confidence, reasons: candidate.reasons, auto: false, merged_by: req.user.id });
    await pool.query(`UPDATE duplicate_candidates SET status='confirmed', resolved_at=NOW(), resolved_by=$1 WHERE id=$2`, [req.user.id, req.params.id]);
    res.json({ success: true, winner_id: winner, loser_id: loser });
  } catch (err) {
    if (err instanceof AlreadyMergedError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dedup/candidates/:id/reject', requireAuth(['admin']), async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(
      `UPDATE duplicate_candidates SET status='rejected', resolved_at=NOW(), resolved_by=$1
       WHERE id=$2 AND org_id=$3 AND status='pending' RETURNING *`,
      [req.user.id, req.params.id, orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pending candidate not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SCORING (Phase 4) ────────────────────────────────────────────
// Scoring runs as a background job (it crawls the company's website to
// detect gaps, same responsible-crawl budget as enrichment).
app.post('/api/companies/:id/score', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(`SELECT id FROM companies WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [req.params.id, orgId]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    const job = await enqueueJob(pool, { org_id: orgId, type: 'score_company', payload: { company_id: req.params.id } });
    res.status(202).json({ success: true, job_id: job.id, status: 'queued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/companies/:id/scores', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(
      `SELECT s.* FROM company_scores s JOIN companies c ON c.id = s.company_id
       WHERE s.company_id=$1 AND c.org_id=$2 ORDER BY s.computed_at DESC LIMIT 20`,
      [req.params.id, orgId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AI RESEARCH (Phase 4) ────────────────────────────────────────
// Optional and provider-agnostic (see lib/ai/provider.js) — if no
// AI_PROVIDER/AI_API_KEY is configured, the job still completes but
// records status='skipped' rather than fabricating research content.
app.post('/api/companies/:id/research', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(`SELECT id FROM companies WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [req.params.id, orgId]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    const job = await enqueueJob(pool, { org_id: orgId, type: 'ai_research', payload: { company_id: req.params.id, requested_by: req.user.id } });
    res.status(202).json({ success: true, job_id: job.id, status: 'queued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/companies/:id/research', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(
      `SELECT r.* FROM company_research r JOIN companies c ON c.id = r.company_id
       WHERE r.company_id=$1 AND c.org_id=$2 ORDER BY r.created_at DESC LIMIT 10`,
      [req.params.id, orgId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── OPPORTUNITIES / CRM PIPELINE (Phase 5) ───────────────────────
const OPPORTUNITY_STAGES = ['new', 'contacted', 'qualified', 'won', 'lost'];

app.post('/api/opportunities', async (req, res) => {
  const { company_id, contact_id, name, deal_value, campaign_id, territory, auto_assign } = req.body;
  if (!company_id || !name) return res.status(400).json({ error: 'company_id and name are required' });
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows: companyRows } = await pool.query(`SELECT id FROM companies WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [company_id, orgId]);
    if (!companyRows.length) return res.status(404).json({ error: 'Company not found' });

    const oppId = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO opportunities (id, org_id, company_id, contact_id, name, deal_value, campaign_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [oppId, orgId, company_id, contact_id || null, name, deal_value || 0, campaign_id || null]
    );
    let opportunity = rows[0];
    await recordActivity(pool, { org_id: orgId, actor_user_id: req.user.id, type: 'opportunity_created', company_id, contact_id: contact_id || null, opportunity_id: oppId, payload: { name } });

    if (auto_assign !== false) {
      const teamId = await pickAssignee(pool, { territory });
      if (teamId) {
        opportunity = await assignOpportunity(pool, { org_id: orgId, opportunity_id: oppId, team_id: teamId });
        await recordActivity(pool, { org_id: orgId, actor_user_id: req.user.id, type: 'opportunity_assigned', company_id, opportunity_id: oppId, payload: { team_id: teamId, auto: true } });
        await createSlaFollowUpTask(pool, { org_id: orgId, opportunity_id: oppId, opportunity_name: name, assigned_to_team_id: teamId, created_by: req.user.id });
      }
    }
    res.json(opportunity);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/opportunities', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const params = [orgId];
    let q = `SELECT * FROM opportunities WHERE org_id=$1 AND deleted_at IS NULL`;
    if (req.query.stage) { params.push(req.query.stage); q += ` AND stage=$${params.length}`; }
    if (req.query.owner_team_id) { params.push(req.query.owner_team_id); q += ` AND owner_team_id=$${params.length}`; }
    q += ` ORDER BY created_at DESC LIMIT 200`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/opportunities/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(`SELECT * FROM opportunities WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!rows.length) return res.status(404).json({ error: 'Opportunity not found' });
    const [tasks, timeline] = await Promise.all([
      pool.query(`SELECT * FROM tasks WHERE opportunity_id=$1 ORDER BY due_at ASC NULLS LAST`, [req.params.id]),
      pool.query(`SELECT * FROM activities WHERE opportunity_id=$1 ORDER BY occurred_at DESC LIMIT 50`, [req.params.id]),
    ]);
    res.json({ ...rows[0], tasks: tasks.rows, timeline: timeline.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/opportunities/:id/stage', async (req, res) => {
  const { stage, lost_reason } = req.body;
  if (!OPPORTUNITY_STAGES.includes(stage)) return res.status(400).json({ error: `stage must be one of: ${OPPORTUNITY_STAGES.join(', ')}` });
  if (stage === 'lost' && !lost_reason) return res.status(400).json({ error: 'lost_reason is required when marking an opportunity lost' });
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows: existing } = await pool.query(`SELECT stage FROM opportunities WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!existing.length) return res.status(404).json({ error: 'Opportunity not found' });
    const closedAt = ['won', 'lost'].includes(stage) ? 'NOW()' : 'NULL';
    const { rows } = await pool.query(
      `UPDATE opportunities SET stage=$1, lost_reason=$2, closed_at=${closedAt}, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [stage, stage === 'lost' ? lost_reason : null, req.params.id]
    );
    await recordActivity(pool, { org_id: orgId, actor_user_id: req.user.id, type: 'stage_changed', company_id: rows[0].company_id, opportunity_id: req.params.id, payload: { from: existing[0].stage, to: stage, lost_reason: stage === 'lost' ? lost_reason : undefined } });
    if (['won', 'lost'].includes(stage)) {
      await recordScoreFeedback(pool, { org_id: orgId, opportunity_id: req.params.id, company_id: rows[0].company_id, outcome: stage, lost_reason: stage === 'lost' ? lost_reason : null });
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/opportunities/:id/assign', requireAuth(['admin']), async (req, res) => {
  const { team_id, territory } = req.body;
  try {
    const orgId = await getOrgId(req.user.id);
    const teamId = team_id || await pickAssignee(pool, { territory });
    if (!teamId) return res.status(400).json({ error: 'No team member available to assign' });
    const opportunity = await assignOpportunity(pool, { org_id: orgId, opportunity_id: req.params.id, team_id: teamId });
    await recordActivity(pool, { org_id: orgId, actor_user_id: req.user.id, type: 'opportunity_assigned', company_id: opportunity.company_id, opportunity_id: req.params.id, payload: { team_id: teamId, auto: !team_id } });
    await createSlaFollowUpTask(pool, { org_id: orgId, opportunity_id: req.params.id, opportunity_name: opportunity.name, assigned_to_team_id: teamId, created_by: req.user.id });
    res.json(opportunity);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TASKS (Phase 5) ───────────────────────────────────────────────
app.post('/api/opportunities/:id/tasks', async (req, res) => {
  const { title, description, due_at, assigned_to_team_id } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows: oppRows } = await pool.query(`SELECT id FROM opportunities WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!oppRows.length) return res.status(404).json({ error: 'Opportunity not found' });
    const task = await createTask(pool, { org_id: orgId, opportunity_id: req.params.id, title, description, due_at, assigned_to_team_id, created_by: req.user.id });
    res.json(task);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/opportunities/:id/tasks', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(
      `SELECT t.* FROM tasks t JOIN opportunities o ON o.id = t.opportunity_id
       WHERE t.opportunity_id=$1 AND o.org_id=$2 ORDER BY t.due_at ASC NULLS LAST`,
      [req.params.id, orgId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/tasks/:id', async (req, res) => {
  const { status } = req.body;
  try {
    const orgId = await getOrgId(req.user.id);
    const task = await completeTask(pool, { org_id: orgId, task_id: req.params.id, status });
    await recordActivity(pool, { org_id: orgId, actor_user_id: req.user.id, type: `task_${status}`, opportunity_id: task.opportunity_id, payload: { task_id: task.id, title: task.title } });
    res.json(task);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── COMPANY TIMELINE (Phase 5) ────────────────────────────────────
app.get('/api/companies/:id/timeline', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows: companyRows } = await pool.query(`SELECT id FROM companies WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!companyRows.length) return res.status(404).json({ error: 'Company not found' });
    const { rows } = await pool.query(
      `SELECT * FROM activities WHERE company_id=$1 ORDER BY occurred_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONTACTS: suppression + outreach (Phase 5) ────────────────────
app.get('/api/contacts/:id', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(`SELECT * FROM contacts WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts/:id/suppress', async (req, res) => {
  const { channel, reason } = req.body;
  if (!['email', 'whatsapp', 'call', 'all'].includes(channel)) return res.status(400).json({ error: 'Invalid channel' });
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows: contactRows } = await pool.query(`SELECT id FROM contacts WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!contactRows.length) return res.status(404).json({ error: 'Contact not found' });
    const suppression = await addSuppression(pool, { org_id: orgId, contact_id: req.params.id, channel, reason, source: 'user_request', created_by: req.user.id });
    await recordActivity(pool, { org_id: orgId, actor_user_id: req.user.id, type: 'contact_suppressed', contact_id: req.params.id, payload: { channel, reason } });
    res.json(suppression);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/contacts/:id/suppress/:channel', requireAuth(['admin']), async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const removed = await removeSuppression(pool, { org_id: orgId, contact_id: req.params.id, channel: req.params.channel });
    if (!removed) return res.status(404).json({ error: 'Suppression not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contacts/:id/suppressions', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(`SELECT * FROM suppressions WHERE org_id=$1 AND contact_id=$2`, [orgId, req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts/:id/outreach', async (req, res) => {
  const { channel, subject, body, opportunity_id } = req.body;
  if (!['email', 'whatsapp'].includes(channel)) return res.status(400).json({ error: 'channel must be email or whatsapp' });
  if (!body) return res.status(400).json({ error: 'body is required' });
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows: contactRows } = await pool.query(`SELECT id FROM contacts WHERE id=$1 AND org_id=$2`, [req.params.id, orgId]);
    if (!contactRows.length) return res.status(404).json({ error: 'Contact not found' });
    const job = await enqueueJob(pool, {
      org_id: orgId, type: 'send_outreach',
      payload: { contact_id: req.params.id, channel, subject, body, opportunity_id: opportunity_id || null, sent_by: req.user.id },
    });
    res.status(202).json({ success: true, job_id: job.id, status: 'queued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contacts/:id/outreach', async (req, res) => {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await pool.query(
      `SELECT * FROM outreach_messages WHERE org_id=$1 AND contact_id=$2 ORDER BY created_at DESC LIMIT 50`,
      [orgId, req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ANALYTICS (Phase 6) ────────────────────────────────────────────
// Read-only aggregation over data collected in Phases 1-5 (lib/analytics/
// reports.js) — admin-only, same as the other cross-org/cross-rep
// reporting endpoints.
app.get('/api/analytics/sources', requireAuth(['admin']), async (req, res) => {
  try { res.json(await analytics.sourceCampaignPerformance(pool, { org_id: await getOrgId(req.user.id) })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/analytics/enrichment', requireAuth(['admin']), async (req, res) => {
  try { res.json(await analytics.enrichmentDuplicateRates(pool, { org_id: await getOrgId(req.user.id) })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/analytics/scoring', requireAuth(['admin']), async (req, res) => {
  try { res.json(await analytics.scoreConversionAnalysis(pool, { org_id: await getOrgId(req.user.id) })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/analytics/pipeline', requireAuth(['admin']), async (req, res) => {
  try { res.json(await analytics.pipelineVelocity(pool, { org_id: await getOrgId(req.user.id) })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/analytics/reps', requireAuth(['admin']), async (req, res) => {
  try { res.json(await analytics.repPerformance(pool, { org_id: await getOrgId(req.user.id) })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/analytics/outreach', requireAuth(['admin']), async (req, res) => {
  try { res.json(await analytics.outreachResponseRates(pool, { org_id: await getOrgId(req.user.id) })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/analytics/revenue', requireAuth(['admin']), async (req, res) => {
  try { res.json(await analytics.revenueAndRoi(pool, { org_id: await getOrgId(req.user.id) })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/analytics/lost-reasons', requireAuth(['admin']), async (req, res) => {
  try { res.json(await analytics.lostReasonsAndScoringFeedback(pool, { org_id: await getOrgId(req.user.id) })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: '✅ LeadFlow CRM Backend is running', db: 'PostgreSQL', port: process.env.PORT });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
// Loopback by default: in production nginx terminates TLS and proxies to this
// port, so binding 0.0.0.0 would also expose the whole API over plain HTTP on
// the public interface, bypassing the certificate. Override with HOST=0.0.0.0
// only when something outside this machine must reach the port directly.
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  console.log(`\n🚀 LeadFlow backend running at http://${HOST}:${PORT}`);
  console.log(`🔗 n8n webhook     → POST http://localhost:${PORT}/webhook/leads`);
  console.log(`📊 Trigger score   → POST http://localhost:${PORT}/api/trigger-score`);
  console.log(`⚡ Full pipeline   → POST http://localhost:${PORT}/api/trigger-all`);
  console.log(`📋 Leads API       → GET  http://localhost:${PORT}/api/leads`);
});

// ── Background job worker (Phase 2 collection framework) ───────
// Polls the `jobs` table in-process so campaign runs/CSV imports don't
// block request/response cycles. Only starts once the `jobs` table
// exists (i.e. migration 002 has been applied) and can be disabled with
// ENABLE_JOB_WORKER=false.
if (process.env.ENABLE_JOB_WORKER !== 'false') {
  pool.query(`SELECT to_regclass('jobs') AS t`)
    .then(({ rows }) => {
      if (rows[0]?.t) {
        startWorker(pool);
        console.log('✅ Job worker started');
      } else {
        console.log('ℹ️ jobs table not found — run `npm run migrate` to enable the job worker');
      }
    })
    .catch((err) => console.error('❌ Job worker startup check failed:', err.message));
}

// ── Graceful EADDRINUSE handling ─────────────────────────────
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use!`);
    console.error(`   Run this to free it:`);
    console.error(`   Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});
