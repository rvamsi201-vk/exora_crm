const crypto = require('crypto');

const BACKOFF_BASE_MS = 30_000; // 30s, 2min, 4.5min, 8min, ...

async function enqueueJob(pool, { org_id, campaign_id = null, run_id = null, type, payload = {}, max_attempts = 5 }) {
  const id = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO jobs (id, org_id, campaign_id, run_id, type, payload, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, org_id, campaign_id, run_id, type, JSON.stringify(payload), max_attempts]
  );
  return rows[0];
}

// Claims and locks the oldest eligible job atomically; safe for multiple
// concurrent pollers thanks to FOR UPDATE SKIP LOCKED.
async function claimNextJob(pool) {
  const { rows } = await pool.query(`
    UPDATE jobs SET status='running', attempts = attempts + 1, locked_at = NOW(), started_at = NOW(), updated_at = NOW()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= NOW()
      ORDER BY run_after ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);
  return rows[0] || null;
}

async function completeJob(pool, jobId, result) {
  await pool.query(
    `UPDATE jobs SET status='succeeded', result=$2, error=NULL, finished_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [jobId, JSON.stringify(result ?? {})]
  );
}

async function failJob(pool, job, error) {
  const message = error?.message || String(error);
  if (job.attempts >= job.max_attempts) {
    await pool.query(
      `UPDATE jobs SET status='failed', error=$2, finished_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [job.id, message]
    );
    return 'failed';
  }
  const delayMs = BACKOFF_BASE_MS * job.attempts * job.attempts;
  await pool.query(
    `UPDATE jobs SET status='queued', error=$2, run_after = NOW() + ($3 || ' milliseconds')::interval, updated_at=NOW() WHERE id=$1`,
    [job.id, message, String(delayMs)]
  );
  return 'retrying';
}

module.exports = { enqueueJob, claimNextJob, completeJob, failJob };
