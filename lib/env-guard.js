const path = require('path');

const BLOCKED_HOSTS = new Set(['93.127.195.245']);

/**
 * Loads `.env` (untouched, may point at the remote DB) then, if present,
 * `.env.local` with override:true so local values win without ever writing
 * to `.env`. `.env.local` is gitignored and only needs to carry the handful
 * of keys a developer wants to override locally (DATABASE_URL, etc.).
 */
function loadEnv() {
  require('dotenv').config();
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
}

/**
 * Refuses to proceed against the known remote database host. Called right
 * after env load, before any Pool is constructed, in every entry point that
 * opens a DB connection.
 */
function assertNotRemoteDatabase(databaseUrl) {
  if (!databaseUrl) return;
  let host;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return;
  }
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run: DATABASE_URL points at the blocked remote host "${host}". ` +
      `Use the local exora_crm_dev database (set it in .env.local) instead.`
    );
  }
}

module.exports = { loadEnv, assertNotRemoteDatabase };
