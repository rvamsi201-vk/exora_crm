-- Phase 2: Collection framework.
-- Purely additive: new tables `jobs` and `campaign_runs`, plus two nullable
-- columns on the Phase 1 `source_records` table. Nothing here touches
-- `leads` or any other pre-existing table.
--
-- Rollback: migrations/rollback/002_phase2_collection_framework.down.sql

-- ── campaign_runs ──────────────────────────────────────────────
-- One row per execution of a discovery_campaigns definition.
CREATE TABLE IF NOT EXISTS campaign_runs (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id   UUID NOT NULL REFERENCES discovery_campaigns(id) ON DELETE CASCADE,
  job_id        UUID,
  status        TEXT NOT NULL DEFAULT 'queued',
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_runs_campaign ON campaign_runs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_runs_org ON campaign_runs(org_id);

-- ── jobs ───────────────────────────────────────────────────────
-- Generic resumable background job queue. Claimed with
-- `FOR UPDATE SKIP LOCKED` so multiple workers can safely poll the same
-- table. status: queued -> running -> succeeded | failed (or back to
-- queued with a future run_after for a retry).
CREATE TABLE IF NOT EXISTS jobs (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id   UUID REFERENCES discovery_campaigns(id) ON DELETE CASCADE,
  run_id        UUID REFERENCES campaign_runs(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  result        JSONB,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at     TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_org ON jobs(org_id);
CREATE INDEX IF NOT EXISTS idx_jobs_campaign ON jobs(campaign_id);

-- ── source_records: two additive columns ────────────────────────
ALTER TABLE source_records ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES campaign_runs(id) ON DELETE SET NULL;
ALTER TABLE source_records ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_source_records_run ON source_records(run_id);
