/**
 * Idempotent backfill: legacy `leads` rows -> companies / company_locations
 * / opportunities / source_records, linked via legacy_lead_links.
 *
 * Never modifies or deletes `leads`. Safe to re-run: any lead already
 * present in legacy_lead_links is skipped.
 *
 * Usage:
 *   node scripts/backfill-legacy-leads.js            Dry run (default).
 *   node scripts/backfill-legacy-leads.js --apply     Actually writes.
 *   node scripts/backfill-legacy-leads.js --apply --limit=500
 */
const { loadEnv, assertNotRemoteDatabase } = require('../lib/env-guard');
loadEnv();
const crypto = require('crypto');
const { Pool } = require('pg');
const { databaseSslConfig } = require('../lib/db-ssl');
const { normalizeDomain, normalizePhone, normalizeCompanyName } = require('../lib/normalize');

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';
const isProduction = process.env.NODE_ENV === 'production';

const apply = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const STAGE_MAP = {
  new: 'new',
  contacted: 'contacted',
  qualified: 'qualified',
  closed: 'won',
  scored: 'new',
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set.');
    process.exit(1);
  }
  try {
    assertNotRemoteDatabase(process.env.DATABASE_URL);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
  if (isProduction && apply && process.env.BACKUP_CONFIRMED !== 'true') {
    console.error('❌ Refusing to write against NODE_ENV=production without BACKUP_CONFIRMED=true.');
    console.error('   Backup command: pg_dump "$DATABASE_URL" -F c -f backup_$(date +%Y%m%d%H%M%S).dump');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: databaseSslConfig() });

  const { rows: check } = await pool.query(
    `SELECT to_regclass('legacy_lead_links') AS t`
  );
  if (!check[0].t) {
    console.error('❌ legacy_lead_links table not found. Run `npm run migrate` first.');
    await pool.end();
    process.exit(1);
  }

  let q = `
    SELECT l.* FROM leads l
    LEFT JOIN legacy_lead_links k ON k.legacy_lead_id = l.id
    WHERE k.id IS NULL
    ORDER BY l.id ASC
  `;
  if (limit) q += ` LIMIT ${limit}`;
  const { rows: leads } = await pool.query(q);

  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${leads.length} unmigrated lead(s) found.`);

  let companiesCreated = 0;
  let companiesReused = 0;
  let opportunitiesCreated = 0;

  for (const lead of leads) {
    const normalizedDomain = normalizeDomain(lead.website);
    const normalizedName = normalizeCompanyName(lead.school_name);
    const normalizedPhone = normalizePhone(lead.phone);

    if (!apply) {
      companiesCreated += 1;
      opportunitiesCreated += 1;
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let company = null;
      if (normalizedDomain) {
        const { rows } = await client.query(
          `SELECT * FROM companies WHERE org_id=$1 AND normalized_domain=$2 LIMIT 1`,
          [DEFAULT_ORG_ID, normalizedDomain]
        );
        company = rows[0] || null;
      }
      if (!company && normalizedName) {
        const { rows } = await client.query(
          `SELECT * FROM companies WHERE org_id=$1 AND normalized_domain IS NULL AND normalized_name=$2 LIMIT 1`,
          [DEFAULT_ORG_ID, normalizedName]
        );
        company = rows[0] || null;
      }

      if (company) {
        companiesReused += 1;
      } else {
        const companyId = crypto.randomUUID();
        const { rows } = await client.query(
          `INSERT INTO companies (id, org_id, name, normalized_name, domain, normalized_domain, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [companyId, DEFAULT_ORG_ID, lead.school_name || 'Unknown', normalizedName,
            lead.website || null, normalizedDomain, JSON.stringify({ legacy_domain: lead.domain || null })]
        );
        company = rows[0];
        companiesCreated += 1;

        if (lead.address) {
          await client.query(
            `INSERT INTO company_locations (id, org_id, company_id, address_line, is_primary)
             VALUES ($1,$2,$3,$4,true)`,
            [crypto.randomUUID(), DEFAULT_ORG_ID, company.id, lead.address]
          );
        }
      }

      const sourceRecordId = crypto.randomUUID();
      await client.query(
        `INSERT INTO source_records (id, org_id, source_type, external_ref, raw_payload, company_id, legacy_lead_id, status)
         VALUES ($1,$2,'legacy_migration',$3,$4,$5,$6,'collected')`,
        [sourceRecordId, DEFAULT_ORG_ID, String(lead.id), JSON.stringify(lead), company.id, lead.id]
      );

      const opportunityId = crypto.randomUUID();
      await client.query(
        `INSERT INTO opportunities (id, org_id, company_id, legacy_lead_id, name, stage, deal_value, owner_team_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [opportunityId, DEFAULT_ORG_ID, company.id, lead.id, lead.school_name || 'Unknown',
          STAGE_MAP[lead.status] || 'new', lead.deal_value || 0, lead.assigned_id || null]
      );
      opportunitiesCreated += 1;

      await client.query(
        `INSERT INTO legacy_lead_links (id, legacy_lead_id, org_id, company_id, opportunity_id, source_record_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [crypto.randomUUID(), lead.id, DEFAULT_ORG_ID, company.id, opportunityId, sourceRecordId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`❌ Lead ${lead.id} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`Companies created: ${companiesCreated}, reused: ${companiesReused}`);
  console.log(`Opportunities created: ${opportunitiesCreated}`);
  if (!apply) console.log('Dry run only — pass --apply to write.');

  await pool.end();
}

main().catch((err) => {
  console.error('❌ Backfill error:', err.message);
  process.exit(1);
});
