-- Minimal legacy schema for tests only (mirrors the subset of server.js's
-- initDB() that migrations/001 depends on via foreign keys). Not used by
-- the running application — server.js creates the real legacy schema.
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
  created_at TIMESTAMPTZ DEFAULT NOW()
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
