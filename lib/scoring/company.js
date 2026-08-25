const crypto = require('crypto');
const { crawlWebsite } = require('../enrichment/website');
const { detectGaps, MAX_BOOST } = require('./gaps');

const VERSION = 'v1';
const WEIGHTS = { opportunity: 0.30, fit: 0.25, completeness: 0.20, intent: 0.15, engagement: 0.10 };

// ── Pure sub-score functions (unit-testable without a DB) ──────────

function computeCompleteness({ hasDomain, hasLocation, hasVerifiedContact, hasDescription, hasIndustryOrSize }) {
  const factors = [
    { name: 'has_domain', points: 20, present: !!hasDomain },
    { name: 'has_location', points: 15, present: !!hasLocation },
    { name: 'has_verified_contact', points: 30, present: !!hasVerifiedContact },
    { name: 'has_description', points: 15, present: !!hasDescription },
    { name: 'has_industry_or_size', points: 20, present: !!hasIndustryOrSize },
  ];
  const value = factors.reduce((sum, f) => sum + (f.present ? f.points : 0), 0);
  return { value: Math.min(value, 100), factors };
}

// Reuses the exact rating/review point table the legacy scorer validated
// in production (lead-scorer.js calcBaseScore), scaled from its 0-45
// sub-range to 0-100. Companies with no legacy rating data get a neutral
// score rather than a fabricated one.
function computeFit({ rating, reviews }) {
  if (rating === null || rating === undefined) {
    return { value: 50, source: 'no_rating_data', rating: null, reviews: reviews ?? null };
  }
  let points = 0;
  const r = parseFloat(rating) || 0;
  if (r >= 4.5) points += 25; else if (r >= 4.0) points += 20; else if (r >= 3.5) points += 14; else if (r >= 3.0) points += 8; else if (r > 0) points += 4;
  const rv = parseInt(reviews) || 0;
  if (rv >= 200) points += 20; else if (rv >= 100) points += 16; else if (rv >= 50) points += 12; else if (rv >= 20) points += 8; else if (rv >= 5) points += 4;
  return { value: Math.round((points / 45) * 100), source: 'legacy_rating_reviews', rating: r, reviews: rv };
}

function computeOpportunity(gaps, websiteStatus) {
  const boost = gaps.reduce((sum, g) => sum + g.boost, 0);
  return { value: Math.round((boost / MAX_BOOST) * 100), gaps: gaps.map((g) => ({ key: g.key, label: g.label, boost: g.boost })), website_status: websiteStatus };
}

const STAGE_INTENT = { new: 20, contacted: 40, qualified: 70, won: 100, lost: 0 };
function computeIntent(opportunityStage) {
  if (!opportunityStage) return { value: 10, opportunity_stage: null };
  return { value: STAGE_INTENT[opportunityStage] ?? 20, opportunity_stage: opportunityStage };
}

function computeEngagement(interactionCount, hasVerifiedContact) {
  let value = 0;
  if (interactionCount >= 6) value = 90;
  else if (interactionCount >= 3) value = 60;
  else if (interactionCount >= 1) value = 30;
  if (hasVerifiedContact) value = Math.min(value + 10, 100);
  return { value, interaction_count: interactionCount, has_verified_contact: !!hasVerifiedContact };
}

function computeOverall(components) {
  const value = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + components[key].value * weight, 0);
  return Math.round(value);
}

// ── DB-driving orchestrator ─────────────────────────────────────

async function computeCompanyScore(pool, { org_id, company_id }) {
  const { rows } = await pool.query(`SELECT * FROM companies WHERE id=$1 AND org_id=$2`, [company_id, org_id]);
  const company = rows[0];
  if (!company) throw new Error('company not found in this org');

  const [locations, contacts, opportunities, legacyLink] = await Promise.all([
    pool.query(`SELECT id FROM company_locations WHERE company_id=$1 AND deleted_at IS NULL LIMIT 1`, [company_id]),
    pool.query(`SELECT * FROM contacts WHERE company_id=$1 AND deleted_at IS NULL`, [company_id]),
    pool.query(`SELECT * FROM opportunities WHERE company_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [company_id]),
    pool.query(
      `SELECT l.rating, l.reviews FROM legacy_lead_links k JOIN leads l ON l.id = k.legacy_lead_id WHERE k.company_id=$1 LIMIT 1`,
      [company_id]
    ),
  ]);
  const { rows: interactionRows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM source_records WHERE company_id=$1) +
       (SELECT COUNT(*) FROM activities WHERE company_id=$1) AS count`,
    [company_id]
  );

  const hasVerifiedContact = contacts.rows.some((c) => c.email_verified || c.phone_verified);

  let websiteStatus = 'missing';
  let gaps = [];
  let hasHttps = false;
  if (company.normalized_domain) {
    const crawl = await crawlWebsite({ domain: company.normalized_domain });
    hasHttps = crawl.has_https;
    if (crawl.skipped_reason) {
      websiteStatus = 'live'; // reachable enough to be told no by robots.txt — treat as live, not a gap signal on its own
    } else if (crawl.home_html) {
      websiteStatus = 'live';
    } else {
      websiteStatus = 'broken';
    }
    gaps = detectGaps(crawl.home_html, websiteStatus, hasHttps);
  } else {
    gaps = detectGaps(null, 'missing', false);
  }

  const completeness = computeCompleteness({
    hasDomain: !!company.normalized_domain,
    hasLocation: locations.rows.length > 0,
    hasVerifiedContact,
    hasDescription: !!company.description,
    hasIndustryOrSize: !!(company.industry || company.size_bucket),
  });
  const fit = computeFit({ rating: legacyLink.rows[0]?.rating ?? null, reviews: legacyLink.rows[0]?.reviews ?? null });
  const opportunity = computeOpportunity(gaps, websiteStatus);
  const intent = computeIntent(opportunities.rows[0]?.stage ?? null);
  const engagement = computeEngagement(parseInt(interactionRows[0].count, 10) || 0, hasVerifiedContact);

  const components = { completeness, fit, opportunity, intent, engagement };
  const overall = computeOverall(components);

  const explanation = { weights: WEIGHTS, components };

  await pool.query(`UPDATE company_scores SET is_current=false WHERE company_id=$1 AND is_current=true`, [company_id]);
  const { rows: inserted } = await pool.query(
    `INSERT INTO company_scores (id, org_id, company_id, version, fit_score, intent_score, completeness_score, engagement_score, opportunity_score, overall_score, explanation, is_current)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) RETURNING *`,
    [crypto.randomUUID(), org_id, company_id, VERSION, fit.value, intent.value, completeness.value, engagement.value, opportunity.value, overall, JSON.stringify(explanation)]
  );

  return inserted[0];
}

module.exports = {
  VERSION, WEIGHTS,
  computeCompleteness, computeFit, computeOpportunity, computeIntent, computeEngagement, computeOverall,
  computeCompanyScore,
};
