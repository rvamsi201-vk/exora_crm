const { nameSimilarity } = require('./similarity');

const SCAN_LIMIT = 5000; // safety cap; scanForDuplicates logs if a scan hits it
// Companies are pre-bucketed by shared first name token before this
// threshold is applied, so it doesn't need to be very strict on its own.
const FUZZY_NAME_THRESHOLD = 0.65;

function pairKey(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

async function fetchActiveCompanies(client, org_id) {
  const { rows } = await client.query(
    `SELECT id, name, normalized_name, normalized_domain, created_at FROM companies
     WHERE org_id=$1 AND deleted_at IS NULL AND merged_into IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [org_id, SCAN_LIMIT]
  );
  return rows;
}

async function fetchActiveContacts(client, org_id) {
  const { rows } = await client.query(
    `SELECT id, normalized_email, normalized_phone, created_at FROM contacts
     WHERE org_id=$1 AND deleted_at IS NULL AND merged_into IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [org_id, SCAN_LIMIT]
  );
  return rows;
}

function findCompanyCandidates(companies) {
  const found = new Map(); // "a|b" -> {entity_id_a, entity_id_b, confidence, reasons}
  const addCandidate = (idA, idB, confidence, reason) => {
    const [a, b] = pairKey(idA, idB);
    const key = `${a}|${b}`;
    const existing = found.get(key);
    if (existing) {
      if (confidence > existing.confidence) existing.confidence = confidence;
      existing.reasons.push(reason);
    } else {
      found.set(key, { entity_id_a: a, entity_id_b: b, confidence, reasons: [reason] });
    }
  };

  // 1. exact domain match
  const byDomain = new Map();
  for (const c of companies) {
    if (!c.normalized_domain) continue;
    if (!byDomain.has(c.normalized_domain)) byDomain.set(c.normalized_domain, []);
    byDomain.get(c.normalized_domain).push(c);
  }
  for (const group of byDomain.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        addCandidate(group[i].id, group[j].id, 0.97, 'exact domain match');
      }
    }
  }

  // 2. exact name match among companies with no domain
  const byName = new Map();
  for (const c of companies) {
    if (c.normalized_domain || !c.normalized_name) continue;
    if (!byName.has(c.normalized_name)) byName.set(c.normalized_name, []);
    byName.get(c.normalized_name).push(c);
  }
  for (const group of byName.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        addCandidate(group[i].id, group[j].id, 0.85, 'exact name match (no domain on either record)');
      }
    }
  }

  // 3. fuzzy name match, bucketed by first name token to limit comparisons
  const byFirstToken = new Map();
  for (const c of companies) {
    if (!c.normalized_name) continue;
    const token = c.normalized_name.split(' ')[0];
    if (!byFirstToken.has(token)) byFirstToken.set(token, []);
    byFirstToken.get(token).push(c);
  }
  for (const group of byFirstToken.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (a.normalized_name === b.normalized_name) continue; // already handled above
        const score = nameSimilarity(a.normalized_name, b.normalized_name);
        if (score >= FUZZY_NAME_THRESHOLD) {
          addCandidate(a.id, b.id, Math.round(score * 0.9 * 1000) / 1000, `similar name (score ${score.toFixed(2)})`);
        }
      }
    }
  }

  return [...found.values()].map((c) => ({ entity_type: 'company', ...c }));
}

function findContactCandidates(contacts) {
  const found = new Map();
  const addCandidate = (idA, idB, confidence, reason) => {
    const [a, b] = pairKey(idA, idB);
    const key = `${a}|${b}`;
    const existing = found.get(key);
    if (existing) {
      if (confidence > existing.confidence) existing.confidence = confidence;
      existing.reasons.push(reason);
    } else {
      found.set(key, { entity_id_a: a, entity_id_b: b, confidence, reasons: [reason] });
    }
  };

  const byEmail = new Map();
  for (const c of contacts) {
    if (!c.normalized_email) continue;
    if (!byEmail.has(c.normalized_email)) byEmail.set(c.normalized_email, []);
    byEmail.get(c.normalized_email).push(c);
  }
  for (const group of byEmail.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) addCandidate(group[i].id, group[j].id, 0.98, 'exact email match');
    }
  }

  const byPhone = new Map();
  for (const c of contacts) {
    if (!c.normalized_phone) continue;
    if (!byPhone.has(c.normalized_phone)) byPhone.set(c.normalized_phone, []);
    byPhone.get(c.normalized_phone).push(c);
  }
  for (const group of byPhone.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) addCandidate(group[i].id, group[j].id, 0.9, 'exact phone match');
    }
  }

  return [...found.values()].map((c) => ({ entity_type: 'contact', ...c }));
}

module.exports = { fetchActiveCompanies, fetchActiveContacts, findCompanyCandidates, findContactCandidates, SCAN_LIMIT };
