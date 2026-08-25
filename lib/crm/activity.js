const crypto = require('crypto');

/**
 * Appends one row to the unified `activities` timeline (Phase 1 schema).
 * Every Phase 5 mutation that matters to a rep — stage change,
 * assignment, task created/completed, outreach sent/delivered/replied —
 * goes through this so a company/opportunity has one real, queryable
 * history instead of scattered side effects.
 */
async function recordActivity(client, { org_id, actor_user_id = null, type, company_id = null, contact_id = null, opportunity_id = null, payload = {} }) {
  const { rows } = await client.query(
    `INSERT INTO activities (id, org_id, actor_user_id, type, company_id, contact_id, opportunity_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [crypto.randomUUID(), org_id, actor_user_id, type, company_id, contact_id, opportunity_id, JSON.stringify(payload)]
  );
  return rows[0];
}

module.exports = { recordActivity };
