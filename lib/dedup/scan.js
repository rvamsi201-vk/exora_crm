const crypto = require('crypto');
const { fetchActiveCompanies, fetchActiveContacts, findCompanyCandidates, findContactCandidates, SCAN_LIMIT } = require('./candidates');
const { mergeCompanies, mergeContacts, AlreadyMergedError } = require('./merge');

// Only exact domain/email matches clear this bar; everything else goes to
// the review queue instead of being merged automatically.
const AUTO_MERGE_THRESHOLD = 0.95;
// Below this, a fuzzy-name match is too weak to be worth a human's time.
const REVIEW_THRESHOLD = 0.55;

async function upsertCandidate(pool, { org_id, entity_type, entity_id_a, entity_id_b, confidence, reasons, status }) {
  const { rows: existing } = await pool.query(
    `SELECT * FROM duplicate_candidates WHERE entity_type=$1 AND entity_id_a=$2 AND entity_id_b=$3`,
    [entity_type, entity_id_a, entity_id_b]
  );
  if (existing.length) {
    if (existing[0].status !== 'pending') return existing[0]; // don't reopen a resolved decision
    const { rows } = await pool.query(
      `UPDATE duplicate_candidates SET confidence=$1, reasons=$2 WHERE id=$3 RETURNING *`,
      [confidence, JSON.stringify(reasons), existing[0].id]
    );
    return rows[0];
  }
  const { rows } = await pool.query(
    `INSERT INTO duplicate_candidates (id, org_id, entity_type, entity_id_a, entity_id_b, confidence, reasons, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [crypto.randomUUID(), org_id, entity_type, entity_id_a, entity_id_b, confidence, JSON.stringify(reasons), status]
  );
  return rows[0];
}

// Older record wins by default: it has the longer provenance/activity trail.
function pickWinnerLoser(byId, idA, idB) {
  const a = byId.get(idA);
  const b = byId.get(idB);
  return new Date(a.created_at) <= new Date(b.created_at) ? [idA, idB] : [idB, idA];
}

async function scanForDuplicates(pool, { org_id }) {
  const stats = { companies_scanned: 0, contacts_scanned: 0, candidates_found: 0, auto_merged: 0, pending: 0, truncated: false };

  const companies = await fetchActiveCompanies(pool, org_id);
  stats.companies_scanned = companies.length;
  if (companies.length === SCAN_LIMIT) stats.truncated = true;
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const companyCandidates = findCompanyCandidates(companies);

  const contacts = await fetchActiveContacts(pool, org_id);
  stats.contacts_scanned = contacts.length;
  if (contacts.length === SCAN_LIMIT) stats.truncated = true;
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const contactCandidates = findContactCandidates(contacts);

  for (const cand of [...companyCandidates, ...contactCandidates]) {
    if (cand.confidence < REVIEW_THRESHOLD) continue;
    stats.candidates_found += 1;
    const byId = cand.entity_type === 'company' ? companyById : contactById;
    const merge = cand.entity_type === 'company' ? mergeCompanies : mergeContacts;

    if (cand.confidence >= AUTO_MERGE_THRESHOLD) {
      const [winner_id, loser_id] = pickWinnerLoser(byId, cand.entity_id_a, cand.entity_id_b);
      try {
        await merge(pool, { org_id, winner_id, loser_id, confidence: cand.confidence, reasons: cand.reasons, auto: true });
        await upsertCandidate(pool, { org_id, ...cand, status: 'auto_merged' });
        stats.auto_merged += 1;
      } catch (err) {
        if (err instanceof AlreadyMergedError) continue; // resolved by an earlier pair in this same scan
        throw err;
      }
    } else {
      await upsertCandidate(pool, { org_id, ...cand, status: 'pending' });
      stats.pending += 1;
    }
  }

  return stats;
}

module.exports = { scanForDuplicates, AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD };
