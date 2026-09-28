/**
 * Projects the Nomi project's user directory into this CRM.
 *
 * Nomi (/var/www/Nomi) is the ONLY place a CRM account comes from. Accounts
 * are not created, renamed, re-roled, or password-changed here — the CRM
 * holds a read-only projection of Nomi's directory, and everything else
 * (leads, companies, opportunities, tasks, analytics) lives in the
 * exora_crm database. server.js refuses local account creation and
 * credential edits so the two cannot drift.
 *
 * What comes from Nomi, and where:
 *   name, email, password  User.name / User.email / User.passwordHash
 *   role                   OrgMember.role  — admin -> admin,
 *                                            member -> salesperson
 *   access                 presence in User. Someone removed from Nomi is
 *                          disabled here on the next run.
 *
 * Passwords carry over untouched: Nomi hashes with bcryptjs at cost 10
 * (lib/auth.ts:90), producing `$2b$10$…` that this app's bcrypt.compare
 * reads directly.
 *
 * Idempotent — safe to re-run, and run hourly by cron.
 *
 * Usage:
 *   node scripts/sync-nomi-users.js             Apply.
 *   node scripts/sync-nomi-users.js --dry-run   Report, write nothing.
 *   node scripts/sync-nomi-users.js --prune     Hard-delete departed users
 *                                               instead of disabling them.
 *
 * Nomi's SQLite file is opened read-only through the `sqlite3` CLI: no
 * native dependency, and the live Nomi database is never opened for writing.
 */
const { loadEnv, assertNotRemoteDatabase } = require('../lib/env-guard');
loadEnv();
const fs = require('fs');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { Pool } = require('pg');
const { databaseSslConfig } = require('../lib/db-ssl');

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';
const NOMI_DB_PATH = process.env.NOMI_DB_PATH || '/var/www/Nomi/data/nomi.db';
const TEAM_COLORS = ['#5b6af7', '#f7695b', '#3fbf7f', '#c05bf7', '#f7b23f', '#3fb6f7'];

const dryRun = process.argv.includes('--dry-run');
const prune = process.argv.includes('--prune');

/**
 * Nomi's role vocabulary is admin | member, held on OrgMember. The CRM's is
 * admin | salesperson. A user with no org membership is treated as a plain
 * member rather than being skipped, so a half-provisioned Nomi account still
 * gets least-privilege access rather than none.
 */
function mapRole(nomiRole) {
  return nomiRole === 'admin' ? 'admin' : 'salesperson';
}

function readNomiUsers() {
  if (!fs.existsSync(NOMI_DB_PATH)) {
    throw new Error(`Nomi database not found at ${NOMI_DB_PATH} (set NOMI_DB_PATH)`);
  }
  // Highest role wins when someone belongs to more than one organisation.
  const sql = `
    SELECT u.id, u.name, u.email, u.passwordHash,
           MAX(CASE WHEN m.role = 'admin' THEN 1 ELSE 0 END) AS isAdmin
      FROM User u
      LEFT JOIN OrgMember m ON m.userId = u.id
     GROUP BY u.id
     ORDER BY u.createdAt;`;
  const out = execFileSync('sqlite3', ['-readonly', '-json', NOMI_DB_PATH, sql], { encoding: 'utf8' }).trim();
  const rows = out ? JSON.parse(out) : [];
  return rows
    .filter((r) => r.email && r.passwordHash)
    .map((r) => ({
      nomiId: r.id,
      name: (r.name || '').trim() || r.email.split('@')[0],
      email: r.email.toLowerCase().trim(),
      passwordHash: r.passwordHash,
      role: mapRole(r.isAdmin ? 'admin' : 'member')
    }));
}

async function ensureSchema(pool) {
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nomi_user_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nomi_user_id
      ON users(nomi_user_id) WHERE nomi_user_id IS NOT NULL;
  `);
}

async function ensureTeamRow(client, user, index) {
  const teamRole = user.role === 'admin' ? 'Admin' : 'Sales Person';
  const existing = await client.query('SELECT id FROM team WHERE LOWER(email) = $1 LIMIT 1', [user.email]);
  if (existing.rows.length) {
    await client.query('UPDATE team SET name = $1, role = $2 WHERE id = $3', [user.name, teamRole, existing.rows[0].id]);
    return existing.rows[0].id;
  }
  const { rows } = await client.query(
    `INSERT INTO team (name, role, email, phone, color, territory)
     VALUES ($1, $2, $3, '', $4, '') RETURNING id`,
    [user.name, teamRole, user.email, TEAM_COLORS[index % TEAM_COLORS.length]]
  );
  return rows[0].id;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set.');
    process.exit(1);
  }
  assertNotRemoteDatabase(process.env.DATABASE_URL);

  const nomiUsers = readNomiUsers();
  console.log(`📖 Nomi (${NOMI_DB_PATH}): ${nomiUsers.length} user(s)`);
  if (!nomiUsers.length) {
    console.error('❌ Refusing to sync: Nomi has no users. Nothing was changed.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: databaseSslConfig() });
  await ensureSchema(pool);

  const summary = { created: 0, updated: 0, unchanged: 0, disabled: 0, reenabled: 0, pruned: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const [index, nomi] of nomiUsers.entries()) {
      const { rows: existingRows } = await client.query(
        `SELECT id, name, password_hash, role, nomi_user_id, disabled_at
           FROM users WHERE email = $1`,
        [nomi.email]
      );
      const existing = existingRows[0];
      let userId;

      if (!existing) {
        const { rows } = await client.query(
          `INSERT INTO users (name, email, password_hash, role, nomi_user_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [nomi.name, nomi.email, nomi.passwordHash, nomi.role, nomi.nomiId]
        );
        userId = rows[0].id;
        summary.created += 1;
        console.log(`  + ${nomi.email.padEnd(28)} ${nomi.role}`);
      } else {
        userId = existing.id;
        const wasDisabled = existing.disabled_at !== null;
        // Nomi is authoritative for every one of these, unconditionally —
        // a role edited in the CRM is corrected on the next run by design.
        const changed =
          existing.name !== nomi.name ||
          existing.password_hash !== nomi.passwordHash ||
          existing.role !== nomi.role ||
          existing.nomi_user_id !== nomi.nomiId ||
          wasDisabled;
        if (changed) {
          await client.query(
            `UPDATE users
                SET name = $1, password_hash = $2, role = $3,
                    nomi_user_id = $4, disabled_at = NULL
              WHERE id = $5`,
            [nomi.name, nomi.passwordHash, nomi.role, nomi.nomiId, userId]
          );
          if (wasDisabled) {
            summary.reenabled += 1;
            console.log(`  ^ ${nomi.email.padEnd(28)} re-enabled (${nomi.role})`);
          } else {
            summary.updated += 1;
            const what = existing.role !== nomi.role ? `role ${existing.role} -> ${nomi.role}` : 'details';
            console.log(`  ~ ${nomi.email.padEnd(28)} ${what}`);
          }
        } else {
          summary.unchanged += 1;
        }
      }

      const teamId = await ensureTeamRow(client, nomi, index);
      await client.query('UPDATE users SET team_id = $1 WHERE id = $2 AND team_id IS DISTINCT FROM $1', [teamId, userId]);
      await client.query(
        `INSERT INTO organization_memberships (id, org_id, user_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL`,
        [crypto.randomUUID(), DEFAULT_ORG_ID, userId, nomi.role]
      );
    }

    // Anyone in the CRM who is not in Nomi loses access. Disabling rather
    // than deleting keeps their activity, call logs and notes attributable.
    const nomiIds = nomiUsers.map((u) => u.nomiId);
    const { rows: departed } = await client.query(
      `SELECT id, email FROM users
        WHERE NOT (nomi_user_id = ANY($1::text[]) AND nomi_user_id IS NOT NULL)`,
      [nomiIds]
    );
    for (const gone of departed) {
      if (prune) {
        await client.query('DELETE FROM users WHERE id = $1', [gone.id]);
        summary.pruned += 1;
        console.log(`  - ${gone.email.padEnd(28)} deleted (absent from Nomi)`);
      } else {
        const { rowCount } = await client.query(
          'UPDATE users SET disabled_at = NOW() WHERE id = $1 AND disabled_at IS NULL',
          [gone.id]
        );
        if (rowCount) {
          summary.disabled += 1;
          console.log(`  ! ${gone.email.padEnd(28)} disabled (absent from Nomi)`);
        }
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('\n🧪 --dry-run: rolled back, nothing was written.');
    } else {
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();

  console.log(
    `\n✅ ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
    `${summary.reenabled} re-enabled, ${summary.disabled} disabled, ${summary.pruned} pruned.`
  );
}

main().catch((err) => {
  console.error('❌ Nomi user sync failed:', err.message);
  process.exit(1);
});
