const crypto = require('crypto');
const provider = require('./provider');

const SYSTEM_PROMPT = `You are a B2B sales research assistant working strictly from the JSON data provided in the user message.
Rules:
- Use ONLY facts present in the provided data. Never invent, assume, or guess a fact that isn't there.
- "decision_makers" must list ONLY people present in the provided contacts array — do not invent names, titles, or people.
- If a section has no supporting data, say so explicitly instead of filling it in.
- Respond with ONLY a JSON object, no prose outside it, with exactly these keys:
  {"summary": string, "buying_signals": string[], "decision_makers": [{"name": string, "title": string|null, "note": string}], "talking_points": string[], "outreach_draft": string}`;

async function gatherSourceData(pool, { org_id, company_id }) {
  const [companyRes, locationsRes, contactsRes, sourceRecordsRes] = await Promise.all([
    pool.query(`SELECT * FROM companies WHERE id=$1 AND org_id=$2`, [company_id, org_id]),
    pool.query(`SELECT address_line, city, state, country FROM company_locations WHERE company_id=$1 AND deleted_at IS NULL`, [company_id]),
    pool.query(`SELECT id, name, title, email, phone, email_verified, phone_verified FROM contacts WHERE company_id=$1 AND deleted_at IS NULL`, [company_id]),
    pool.query(
      `SELECT id, source_type, raw_payload, fetched_at FROM source_records
       WHERE company_id=$1 AND status='collected' ORDER BY fetched_at DESC LIMIT 5`,
      [company_id]
    ),
  ]);
  const company = companyRes.rows[0];
  if (!company) throw new Error('company not found in this org');

  return {
    company: { name: company.name, domain: company.domain, industry: company.industry, size_bucket: company.size_bucket, description: company.description },
    locations: locationsRes.rows,
    contacts: contactsRes.rows,
    recent_source_records: sourceRecordsRes.rows.map((r) => ({ id: r.id, source_type: r.source_type, fetched_at: r.fetched_at, data: r.raw_payload })),
  };
}

function parseModelResponse(text) {
  // Models sometimes wrap JSON in a code fence despite instructions; strip it defensively.
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
}

/**
 * Produces source-backed research for one company. Never fabricates
 * content: if no AI provider is configured, returns status='skipped'
 * with no summary/signals/etc — the caller must not present that as
 * research having happened.
 */
async function researchCompany(pool, { org_id, company_id, requested_by = null, generateFn = provider.generate }) {
  const record = async (fields) => {
    const { rows } = await pool.query(
      `INSERT INTO company_research (id, org_id, company_id, status, provider, model, summary, buying_signals, decision_makers, talking_points, outreach_draft, source_record_ids, error, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        crypto.randomUUID(), org_id, company_id, fields.status, fields.provider || null, fields.model || null,
        fields.summary || null, JSON.stringify(fields.buying_signals || []), JSON.stringify(fields.decision_makers || []),
        JSON.stringify(fields.talking_points || []), fields.outreach_draft || null,
        JSON.stringify(fields.source_record_ids || []), fields.error || null, requested_by,
      ]
    );
    return rows[0];
  };

  if (!provider.isConfigured() && generateFn === provider.generate) {
    return record({ status: 'skipped', error: 'AI provider not configured (set AI_PROVIDER and AI_API_KEY)' });
  }

  const data = await gatherSourceData(pool, { org_id, company_id });
  const sourceRecordIds = data.recent_source_records.map((r) => r.id);

  let result;
  try {
    result = await generateFn({ system: SYSTEM_PROMPT, prompt: JSON.stringify(data) });
  } catch (err) {
    return record({ status: 'error', error: err.message });
  }

  try {
    const parsed = parseModelResponse(result.text);
    return record({
      status: 'completed', provider: result.provider, model: result.model,
      summary: parsed.summary, buying_signals: parsed.buying_signals, decision_makers: parsed.decision_makers,
      talking_points: parsed.talking_points, outreach_draft: parsed.outreach_draft, source_record_ids: sourceRecordIds,
    });
  } catch {
    // The model didn't return valid JSON — store the raw text rather than
    // silently discarding it or pretending it fit the structured shape.
    return record({
      status: 'completed_unstructured', provider: result.provider, model: result.model,
      summary: result.text, source_record_ids: sourceRecordIds,
    });
  }
}

module.exports = { researchCompany, gatherSourceData, parseModelResponse, SYSTEM_PROMPT };
