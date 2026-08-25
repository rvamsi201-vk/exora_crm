-- Phase 6: Analytics and learning.
-- Purely additive: one nullable column on opportunities, one new table.
--
-- Rollback: migrations/rollback/006_phase6_analytics.down.sql

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS lost_reason TEXT;

-- ── score_feedback ─────────────────────────────────────────────
-- Snapshot of a company's score at the moment its opportunity closed,
-- paired with the real outcome. This is the "Learn" step of the
-- pipeline: it's what score-to-conversion analysis and lost-reason
-- reporting are computed from (see lib/analytics/reports.js).
-- overall_score_at_close is denormalized (copied, not just referenced)
-- so this stays meaningful even if the scoring row it came from is later
-- superseded by a newer version.
CREATE TABLE IF NOT EXISTS score_feedback (
  id                      UUID PRIMARY KEY,
  org_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id          UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  company_score_id        UUID REFERENCES company_scores(id) ON DELETE SET NULL,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('won', 'lost')),
  lost_reason             TEXT,
  overall_score_at_close  NUMERIC,
  fit_score_at_close      NUMERIC,
  opportunity_score_at_close NUMERIC,
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_score_feedback_org_outcome ON score_feedback(org_id, outcome);
