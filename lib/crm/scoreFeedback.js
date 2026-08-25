const crypto = require('crypto');

/**
 * Snapshots the company's current score (if any) against the real
 * outcome of a closed opportunity. Called from the stage-change route
 * whenever an opportunity moves to 'won' or 'lost' — this is the data
 * lib/analytics/reports.js's score-to-conversion and lost-reason reports
 * are built from. A no-op (returns null) if the company was never
 * scored — we never fabricate a score for the feedback record.
 */
async function recordScoreFeedback(pool, { org_id, opportunity_id, company_id, outcome, lost_reason = null }) {
  const { rows: scoreRows } = await pool.query(
    `SELECT * FROM company_scores WHERE company_id=$1 AND is_current=true LIMIT 1`,
    [company_id]
  );
  const score = scoreRows[0] || null;

  const { rows } = await pool.query(
    `INSERT INTO score_feedback (id, org_id, opportunity_id, company_id, company_score_id, outcome, lost_reason, overall_score_at_close, fit_score_at_close, opportunity_score_at_close)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (opportunity_id) DO UPDATE SET
       outcome=EXCLUDED.outcome, lost_reason=EXCLUDED.lost_reason, company_score_id=EXCLUDED.company_score_id,
       overall_score_at_close=EXCLUDED.overall_score_at_close, fit_score_at_close=EXCLUDED.fit_score_at_close,
       opportunity_score_at_close=EXCLUDED.opportunity_score_at_close, recorded_at=NOW()
     RETURNING *`,
    [
      crypto.randomUUID(), org_id, opportunity_id, company_id, score?.id || null, outcome, lost_reason,
      score?.overall_score ?? null, score?.fit_score ?? null, score?.opportunity_score ?? null,
    ]
  );
  return rows[0];
}

module.exports = { recordScoreFeedback };
