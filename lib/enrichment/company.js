const crypto = require('crypto');
const { crawlWebsite } = require('./website');
const { findOrCreateContact } = require('../companies');

/**
 * Enriches one company from its own public website: crawls the homepage
 * (+ a contact page, if robots.txt allows), records a source_records
 * provenance row either way, and fills in complementary data — never
 * overwrites a field the company already has.
 */
async function enrichCompany(pool, { org_id, company_id }) {
  const { rows } = await pool.query(`SELECT * FROM companies WHERE id=$1 AND org_id=$2`, [company_id, org_id]);
  const company = rows[0];
  if (!company) throw new Error('company not found in this org');

  if (!company.normalized_domain) {
    await pool.query(`UPDATE companies SET enriched_at=NOW() WHERE id=$1`, [company_id]);
    return { skipped: true, reason: 'no domain on this company' };
  }

  const crawl = await crawlWebsite({ domain: company.normalized_domain });
  const { home_html, ...crawlForStorage } = crawl; // never persist raw page markup in provenance

  await pool.query(
    `INSERT INTO source_records (id, org_id, source_type, external_ref, raw_payload, company_id, status, error)
     VALUES ($1,$2,'website_enrichment',$3,$4,$5,$6,$7)`,
    [
      crypto.randomUUID(), org_id, company.normalized_domain, JSON.stringify(crawlForStorage), company_id,
      crawl.errors?.length || crawl.skipped_reason ? 'error' : 'collected',
      crawl.skipped_reason || (crawl.errors?.[0]?.message ?? null),
    ]
  );

  let contactsFound = 0;
  const emails = crawl.emails || [];
  const phones = crawl.phones || [];
  const pairs = Math.max(emails.length, phones.length, 1);
  for (let i = 0; i < pairs; i++) {
    const email = emails[i] || emails[0] || null;
    const phone = phones[i] || phones[0] || null;
    if (!email && !phone) continue;
    const contact = await findOrCreateContact(pool, {
      org_id, company_id, email, phone, source: 'website_enrichment', verified: true,
    });
    if (contact) contactsFound += 1;
    if (emails.length <= 1 && phones.length <= 1) break; // avoid pairing unrelated emails/phones
  }

  if (crawl.description && !company.description) {
    await pool.query(`UPDATE companies SET description=$1 WHERE id=$2`, [crawl.description, company_id]);
  }
  await pool.query(`UPDATE companies SET enriched_at=NOW() WHERE id=$1`, [company_id]);

  return {
    skipped: false,
    pages_fetched: crawl.pages_fetched?.length || 0,
    emails_found: emails.length,
    phones_found: phones.length,
    contacts_touched: contactsFound,
    has_https: crawl.has_https,
    skipped_reason: crawl.skipped_reason || null,
  };
}

module.exports = { enrichCompany };
