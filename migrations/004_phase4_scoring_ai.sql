-- Phase 4: Scoring and AI research.
-- Purely additive: two new tables, no changes to any existing table.
--
-- Rollback: migrations/rollback/004_phase4_scoring_ai.down.sql

-- ── company_scores ────────────────────────────────────────────
-- One row per scoring run (versioned history); is_current flags the
-- latest. fit/intent/completeness/engagement/opportunity are 0-100
-- sub-scores, overall_score is their weighted composite. `explanation`
-- records exactly which signals produced each sub-score, for audit.
CREATE TABLE IF NOT EXISTS company_scores (
  id                  UUID PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version             TEXT NOT NULL DEFAULT 'v1',
  fit_score           NUMERIC NOT NULL,
  intent_score        NUMERIC NOT NULL,
  completeness_score  NUMERIC NOT NULL,
  engagement_score    NUMERIC NOT NULL,
  opportunity_score   NUMERIC NOT NULL,
  overall_score       NUMERIC NOT NULL,
  explanation         JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_current          BOOLEAN NOT NULL DEFAULT true,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_scores_company ON company_scores(company_id, computed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_scores_current ON company_scores(company_id) WHERE is_current;

-- ── company_research ──────────────────────────────────────────
-- Source-backed AI research output (summary, buying signals,
-- decision-maker notes, talking points, an outreach draft). status is
-- 'skipped' whenever no AI provider is configured — the app must never
-- fabricate research content, only report that none was generated.
-- source_record_ids records exactly which provenance rows were fed into
-- the prompt, so every claim can be traced back to real collected data.
CREATE TABLE IF NOT EXISTS company_research (
  id                 UUID PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK (status IN ('completed', 'completed_unstructured', 'skipped', 'error')),
  provider           TEXT,
  model              TEXT,
  summary            TEXT,
  buying_signals     JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision_makers    JSONB NOT NULL DEFAULT '[]'::jsonb,
  talking_points     JSONB NOT NULL DEFAULT '[]'::jsonb,
  outreach_draft     TEXT,
  source_record_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  error              TEXT,
  requested_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_research_company ON company_research(company_id, created_at DESC);
