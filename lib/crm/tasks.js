const crypto = require('crypto');

const DEFAULT_SLA_HOURS = parseInt(process.env.SLA_FIRST_CONTACT_HOURS || '24', 10);

async function createTask(pool, { org_id, opportunity_id, title, description = null, due_at = null, assigned_to_team_id = null, created_by = null }) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (id, org_id, opportunity_id, title, description, due_at, assigned_to_team_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [crypto.randomUUID(), org_id, opportunity_id, title, description, due_at, assigned_to_team_id, created_by]
  );
  return rows[0];
}

// Auto-created whenever an opportunity is (re)assigned — the concrete SLA
// behavior for this phase: first contact is expected within
// SLA_FIRST_CONTACT_HOURS of assignment.
async function createSlaFollowUpTask(pool, { org_id, opportunity_id, opportunity_name, assigned_to_team_id, created_by = null }) {
  const due_at = new Date(Date.now() + DEFAULT_SLA_HOURS * 3600 * 1000);
  return createTask(pool, {
    org_id, opportunity_id, assigned_to_team_id, created_by,
    title: `First contact: ${opportunity_name}`,
    description: `Auto-created on assignment — SLA is first contact within ${DEFAULT_SLA_HOURS}h.`,
    due_at,
  });
}

async function completeTask(pool, { org_id, task_id, status }) {
  if (!['done', 'cancelled'].includes(status)) throw new Error('status must be done or cancelled');
  const { rows } = await pool.query(
    `UPDATE tasks SET status=$1, completed_at=NOW(), updated_at=NOW() WHERE id=$2 AND org_id=$3 RETURNING *`,
    [status, task_id, org_id]
  );
  if (!rows.length) throw new Error('task not found in this org');
  return rows[0];
}

module.exports = { createTask, createSlaFollowUpTask, completeTask, DEFAULT_SLA_HOURS };
