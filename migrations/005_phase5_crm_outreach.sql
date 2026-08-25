-- Phase 5: CRM and outreach.
-- Purely additive: three new tables (tasks, suppressions,
-- outreach_messages) plus one nullable column on opportunities.
--
-- Rollback: migrations/rollback/005_phase5_crm_outreach.down.sql

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- ── tasks ──────────────────────────────────────────────────────
-- Opportunity-scoped follow-ups, including the auto-created SLA task
-- created on assignment (see lib/crm/tasks.js). status/due_at together
-- give the "overdue" signal — a task is at-risk when
-- status='open' AND due_at < now().
CREATE TABLE IF NOT EXISTS tasks (
  id                   UUID PRIMARY KEY,
  org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id       UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  description          TEXT,
  due_at               TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  assigned_to_team_id  INTEGER REFERENCES team(id) ON DELETE SET NULL,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_opportunity ON tasks(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org_status_due ON tasks(org_id, status, due_at);

-- ── suppressions ───────────────────────────────────────────────
-- Per-channel opt-out/suppression. `contacts.opted_out` (Phase 1) remains
-- the blunt "block everything" flag; this adds channel granularity and a
-- recorded reason/source. A contact is suppressed for a channel if
-- opted_out=true OR a row exists here with channel IN (that channel,'all').
CREATE TABLE IF NOT EXISTS suppressions (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'call', 'all')),
  reason      TEXT,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bounce', 'complaint', 'opt_out_link', 'user_request')),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contact_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_suppressions_contact ON suppressions(contact_id);

-- ── outreach_messages ─────────────────────────────────────────
-- Every send attempt, including ones blocked by suppression and ones
-- simulated outside production (see lib/outreach/send.js) — 'simulated'
-- is a distinct status so a dev/test run can never be mistaken for a
-- real send in the record.
CREATE TABLE IF NOT EXISTS outreach_messages (
  id                   UUID PRIMARY KEY,
  org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id           UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id           UUID REFERENCES companies(id) ON DELETE SET NULL,
  opportunity_id       UUID REFERENCES opportunities(id) ON DELETE SET NULL,
  channel              TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  direction            TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  subject              TEXT,
  body                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'simulated', 'sent', 'delivered', 'failed', 'replied', 'suppressed')),
  provider             TEXT,
  provider_message_id  TEXT,
  error                TEXT,
  sent_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at              TIMESTAMPTZ,
  delivered_at         TIMESTAMPTZ,
  replied_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outreach_contact ON outreach_messages(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_opportunity ON outreach_messages(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_outreach_provider_msg ON outreach_messages(provider_message_id);
