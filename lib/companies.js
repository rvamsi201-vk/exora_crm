const crypto = require('crypto');
const { normalizeDomain, normalizeEmail, normalizePhone, normalizeCompanyName, normalizeLocationPart } = require('./normalize');

/**
 * Find-or-create a company within an org, matching first by normalized
 * domain, then by normalized name. Shared by the Phase 2 job worker.
 * (scripts/backfill-legacy-leads.js keeps its own copy of this logic
 * deliberately, so that already-tested script isn't touched here.)
 */
async function findOrCreateCompany(client, { org_id, name, domain }) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedName = normalizeCompanyName(name);

  if (normalizedDomain) {
    const { rows } = await client.query(
      `SELECT * FROM companies WHERE org_id=$1 AND normalized_domain=$2 LIMIT 1`,
      [org_id, normalizedDomain]
    );
    if (rows[0]) return { company: rows[0], created: false };
  }
  if (normalizedName) {
    const { rows } = await client.query(
      `SELECT * FROM companies WHERE org_id=$1 AND normalized_domain IS NULL AND normalized_name=$2 LIMIT 1`,
      [org_id, normalizedName]
    );
    if (rows[0]) return { company: rows[0], created: false };
  }

  const { rows } = await client.query(
    `INSERT INTO companies (id, org_id, name, normalized_name, domain, normalized_domain)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [crypto.randomUUID(), org_id, name, normalizedName, domain || null, normalizedDomain]
  );
  return { company: rows[0], created: true };
}

async function addLocationIfMissing(client, { org_id, company_id, address_line, city, area, state, country, postal_code }) {
  if (!address_line) return null;
  const { rows: existing } = await client.query(
    `SELECT id FROM company_locations WHERE company_id=$1 AND address_line=$2 LIMIT 1`,
    [company_id, address_line]
  );
  if (existing[0]) return existing[0].id;

  const { rows: primaryCheck } = await client.query(
    `SELECT id FROM company_locations WHERE company_id=$1 AND is_primary=true LIMIT 1`,
    [company_id]
  );
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO company_locations
       (id, org_id, company_id, address_line, city, area, state, country, postal_code, normalized_city, normalized_area, is_primary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, org_id, company_id, address_line, city || null, area || null, state || null, country || null, postal_code || null,
      normalizeLocationPart(city), normalizeLocationPart(area), !primaryCheck[0]]
  );
  return id;
}

// `verified: true` means the caller confirmed this email/phone by finding
// it directly on the company's own website (see lib/enrichment/company.js)
// — not a third-party verification service.
async function findOrCreateContact(client, { org_id, company_id, name, email, phone, source = 'collector', verified = false }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedEmail && !normalizedPhone) return null;

  let existing = null;
  if (normalizedEmail) {
    const { rows } = await client.query(
      `SELECT * FROM contacts WHERE org_id=$1 AND normalized_email=$2 LIMIT 1`,
      [org_id, normalizedEmail]
    );
    existing = rows[0] || null;
  }
  if (!existing && normalizedPhone) {
    const { rows } = await client.query(
      `SELECT * FROM contacts WHERE org_id=$1 AND normalized_phone=$2 LIMIT 1`,
      [org_id, normalizedPhone]
    );
    existing = rows[0] || null;
  }

  if (existing) {
    if (verified && (!existing.email_verified || !existing.phone_verified)) {
      const { rows } = await client.query(
        `UPDATE contacts SET
           email_verified = email_verified OR ($1 AND normalized_email IS NOT NULL),
           phone_verified = phone_verified OR ($1 AND normalized_phone IS NOT NULL)
         WHERE id=$2 RETURNING *`,
        [verified, existing.id]
      );
      return rows[0];
    }
    return existing;
  }

  const { rows } = await client.query(
    `INSERT INTO contacts (id, org_id, company_id, name, email, normalized_email, phone, normalized_phone, source, email_verified, phone_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [crypto.randomUUID(), org_id, company_id || null, name || null, email || null, normalizedEmail, phone || null, normalizedPhone,
      source, verified && !!normalizedEmail, verified && !!normalizedPhone]
  );
  return rows[0];
}

module.exports = { findOrCreateCompany, addLocationIfMissing, findOrCreateContact };
