/**
 * Read-only aggregation reports over data already collected in Phases
 * 1-5. Every number here is computed directly from stored rows — nothing
 * is estimated, predicted, or AI-generated. Where a real answer would
 * require data the system doesn't track (e.g. ad spend, for true ROI),
 * the report says so explicitly instead of inventing a figure.
 */

function rate(numerator, denominator) {
  const d = Number(denominator);
  if (!d) return null;
  return Math.round((Number(numerator) / d) * 1000) / 1000;
}

async function sourceCampaignPerformance(pool, { org_id }) {
  const [bySource, byCampaign] = await Promise.all([
    pool.query(
      `SELECT source_type,
              COUNT(*) AS records,
              COUNT(*) FILTER (WHERE status = 'collected') AS collected,
              COUNT(*) FILTER (WHERE status = 'error') AS errors,
              COUNT(DISTINCT company_id) AS companies_touched
       FROM source_records WHERE org_id=$1 GROUP BY source_type ORDER BY records DESC`,
      [org_id]
    ),
    pool.query(
      `SELECT c.id, c.name, c.source_type, c.status,
              COUNT(r.id) AS runs,
              COUNT(r.id) FILTER (WHERE r.status IN ('succeeded', 'completed', 'completed_with_errors')) AS successful_runs,
              COUNT(r.id) FILTER (WHERE r.status = 'failed') AS failed_runs
       FROM discovery_campaigns c
       LEFT JOIN campaign_runs r ON r.campaign_id = c.id
       WHERE c.org_id=$1
       GROUP BY c.id, c.name, c.source_type, c.status
       ORDER BY runs DESC`,
      [org_id]
    ),
  ]);
  return { by_source: bySource.rows, by_campaign: byCampaign.rows };
}

async function enrichmentDuplicateRates(pool, { org_id }) {
  const [companies, candidates, merges] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE enriched_at IS NOT NULL) AS enriched
       FROM companies WHERE org_id=$1 AND deleted_at IS NULL`,
      [org_id]
    ),
    pool.query(`SELECT entity_type, status, COUNT(*) AS count FROM duplicate_candidates WHERE org_id=$1 GROUP BY entity_type, status`, [org_id]),
    pool.query(`SELECT entity_type, COUNT(*) AS count FROM entity_merges WHERE org_id=$1 GROUP BY entity_type`, [org_id]),
  ]);
  const { total, enriched } = companies.rows[0];
  return {
    companies_total: Number(total),
    companies_enriched: Number(enriched),
    enrichment_rate: rate(enriched, total),
    duplicate_candidates_by_status: candidates.rows,
    merges_by_type: merges.rows,
  };
}

const SCORE_BUCKETS = ['unscored', '0-20', '21-40', '41-60', '61-80', '81-100'];

async function scoreConversionAnalysis(pool, { org_id }) {
  const { rows } = await pool.query(
    `SELECT
       CASE
         WHEN overall_score_at_close IS NULL THEN 'unscored'
         WHEN overall_score_at_close <= 20 THEN '0-20'
         WHEN overall_score_at_close <= 40 THEN '21-40'
         WHEN overall_score_at_close <= 60 THEN '41-60'
         WHEN overall_score_at_close <= 80 THEN '61-80'
         ELSE '81-100'
       END AS bucket,
       COUNT(*) FILTER (WHERE outcome = 'won') AS won,
       COUNT(*) FILTER (WHERE outcome = 'lost') AS lost,
       COUNT(*) AS total
     FROM score_feedback WHERE org_id=$1
     GROUP BY bucket`,
    [org_id]
  );
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const buckets = SCORE_BUCKETS.map((bucket) => {
    const r = byBucket.get(bucket) || { won: 0, lost: 0, total: 0 };
    return { bucket, won: Number(r.won), lost: Number(r.lost), total: Number(r.total), win_rate: rate(r.won, r.total) };
  });
  const totals = buckets.reduce((acc, b) => ({ won: acc.won + b.won, lost: acc.lost + b.lost, total: acc.total + b.total }), { won: 0, lost: 0, total: 0 });
  return { buckets, overall_win_rate: rate(totals.won, totals.total), total_closed: totals.total };
}

async function pipelineVelocity(pool, { org_id }) {
  const [timing, openByStage] = await Promise.all([
    pool.query(
      `SELECT
         AVG(EXTRACT(EPOCH FROM (assigned_at - created_at)) / 86400) FILTER (WHERE assigned_at IS NOT NULL) AS avg_days_to_assign,
         AVG(EXTRACT(EPOCH FROM (closed_at - assigned_at)) / 86400) FILTER (WHERE closed_at IS NOT NULL AND assigned_at IS NOT NULL AND stage = 'won') AS avg_days_to_close_won,
         AVG(EXTRACT(EPOCH FROM (closed_at - assigned_at)) / 86400) FILTER (WHERE closed_at IS NOT NULL AND assigned_at IS NOT NULL AND stage = 'lost') AS avg_days_to_close_lost
       FROM opportunities WHERE org_id=$1 AND deleted_at IS NULL`,
      [org_id]
    ),
    pool.query(
      `SELECT stage, COUNT(*) AS count, AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) AS avg_age_days
       FROM opportunities WHERE org_id=$1 AND deleted_at IS NULL AND stage NOT IN ('won', 'lost')
       GROUP BY stage`,
      [org_id]
    ),
  ]);
  const t = timing.rows[0];
  return {
    avg_days_to_assign: t.avg_days_to_assign !== null ? Math.round(t.avg_days_to_assign * 10) / 10 : null,
    avg_days_to_close_won: t.avg_days_to_close_won !== null ? Math.round(t.avg_days_to_close_won * 10) / 10 : null,
    avg_days_to_close_lost: t.avg_days_to_close_lost !== null ? Math.round(t.avg_days_to_close_lost * 10) / 10 : null,
    open_by_stage: openByStage.rows.map((r) => ({ stage: r.stage, count: Number(r.count), avg_age_days: Math.round(r.avg_age_days * 10) / 10 })),
  };
}

async function repPerformance(pool, { org_id }) {
  const { rows } = await pool.query(
    `SELECT t.id AS team_id, t.name, t.email,
            COUNT(o.id) AS opportunities_owned,
            COUNT(o.id) FILTER (WHERE o.stage = 'won') AS won,
            COUNT(o.id) FILTER (WHERE o.stage = 'lost') AS lost,
            COALESCE(SUM(o.deal_value) FILTER (WHERE o.stage = 'won'), 0) AS won_value,
            (SELECT COUNT(*) FROM tasks tk WHERE tk.assigned_to_team_id = t.id AND tk.status = 'done') AS tasks_done,
            (SELECT COUNT(*) FROM tasks tk WHERE tk.assigned_to_team_id = t.id AND tk.status = 'open' AND tk.due_at < NOW()) AS tasks_overdue
     FROM team t
     LEFT JOIN opportunities o ON o.owner_team_id = t.id AND o.org_id = $1 AND o.deleted_at IS NULL
     GROUP BY t.id, t.name, t.email
     ORDER BY won_value DESC`,
    [org_id]
  );
  return rows.map((r) => ({
    team_id: r.team_id, name: r.name, email: r.email,
    opportunities_owned: Number(r.opportunities_owned), won: Number(r.won), lost: Number(r.lost),
    win_rate: rate(r.won, Number(r.won) + Number(r.lost)),
    won_value: Number(r.won_value), tasks_done: Number(r.tasks_done), tasks_overdue: Number(r.tasks_overdue),
  }));
}

async function outreachResponseRates(pool, { org_id }) {
  const { rows } = await pool.query(
    `SELECT channel,
            COUNT(*) AS attempted,
            COUNT(*) FILTER (WHERE status IN ('sent', 'delivered', 'replied', 'simulated')) AS sent,
            COUNT(*) FILTER (WHERE status IN ('delivered', 'replied')) AS delivered,
            COUNT(*) FILTER (WHERE status = 'replied') AS replied,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed,
            COUNT(*) FILTER (WHERE status = 'suppressed') AS suppressed
     FROM outreach_messages WHERE org_id=$1 GROUP BY channel`,
    [org_id]
  );
  return rows.map((r) => ({
    channel: r.channel, attempted: Number(r.attempted), sent: Number(r.sent), delivered: Number(r.delivered),
    replied: Number(r.replied), failed: Number(r.failed), suppressed: Number(r.suppressed),
    delivery_rate: rate(r.delivered, r.sent), reply_rate: rate(r.replied, r.sent),
  }));
}

async function revenueAndRoi(pool, { org_id }) {
  const [totals, bySource] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE stage = 'won') AS won_count,
         COALESCE(SUM(deal_value) FILTER (WHERE stage = 'won'), 0) AS revenue_won,
         COUNT(*) FILTER (WHERE stage = 'lost') AS lost_count,
         COALESCE(SUM(deal_value) FILTER (WHERE stage = 'lost'), 0) AS pipeline_value_lost,
         COUNT(*) FILTER (WHERE stage NOT IN ('won', 'lost')) AS open_count,
         COALESCE(SUM(deal_value) FILTER (WHERE stage NOT IN ('won', 'lost')), 0) AS pipeline_value_open
       FROM opportunities WHERE org_id=$1 AND deleted_at IS NULL`,
      [org_id]
    ),
    pool.query(
      `SELECT c.name AS campaign_name, c.source_type, COALESCE(SUM(o.deal_value) FILTER (WHERE o.stage = 'won'), 0) AS revenue_won
       FROM opportunities o JOIN discovery_campaigns c ON c.id = o.campaign_id
       WHERE o.org_id=$1 GROUP BY c.name, c.source_type ORDER BY revenue_won DESC`,
      [org_id]
    ),
  ]);
  const t = totals.rows[0];
  return {
    won_count: Number(t.won_count), revenue_won: Number(t.revenue_won),
    lost_count: Number(t.lost_count), pipeline_value_lost: Number(t.pipeline_value_lost),
    open_count: Number(t.open_count), pipeline_value_open: Number(t.pipeline_value_open),
    revenue_won_by_campaign: bySource.rows.map((r) => ({ ...r, revenue_won: Number(r.revenue_won) })),
    roi_note: 'True ROI (revenue / acquisition cost) is not reported: no spend/cost data is tracked anywhere in the system. revenue_won and revenue_won_by_campaign are the real figures available.',
  };
}

async function lostReasonsAndScoringFeedback(pool, { org_id }) {
  const [reasons, byOutcome] = await Promise.all([
    pool.query(
      `SELECT COALESCE(lost_reason, '(no reason recorded)') AS lost_reason, COUNT(*) AS count
       FROM score_feedback WHERE org_id=$1 AND outcome='lost' GROUP BY lost_reason ORDER BY count DESC`,
      [org_id]
    ),
    pool.query(
      `SELECT outcome, COUNT(*) AS count,
              AVG(overall_score_at_close) AS avg_overall_score,
              AVG(fit_score_at_close) AS avg_fit_score,
              AVG(opportunity_score_at_close) AS avg_opportunity_score
       FROM score_feedback WHERE org_id=$1 GROUP BY outcome`,
      [org_id]
    ),
  ]);
  return {
    lost_reasons: reasons.rows.map((r) => ({ lost_reason: r.lost_reason, count: Number(r.count) })),
    score_by_outcome: byOutcome.rows.map((r) => ({
      outcome: r.outcome, count: Number(r.count),
      avg_overall_score: r.avg_overall_score !== null ? Math.round(r.avg_overall_score * 10) / 10 : null,
      avg_fit_score: r.avg_fit_score !== null ? Math.round(r.avg_fit_score * 10) / 10 : null,
      avg_opportunity_score: r.avg_opportunity_score !== null ? Math.round(r.avg_opportunity_score * 10) / 10 : null,
    })),
  };
}

module.exports = {
  sourceCampaignPerformance, enrichmentDuplicateRates, scoreConversionAnalysis, pipelineVelocity,
  repPerformance, outreachResponseRates, revenueAndRoi, lostReasonsAndScoringFeedback, rate,
};
