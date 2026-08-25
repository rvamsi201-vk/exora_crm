-- Phase 1: Data foundation.
-- Purely additive: creates new tables and one nullable column on `leads`.
-- Nothing here deletes, renames, or type-converts any existing column.
-- IDs are UUIDs supplied by application code (crypto.randomUUID()) so this
-- does not depend on a pgcrypto/uuid-ossp extension being installable.
--
-- Rollback: migrations/rollback/001_phase1_data_foundation.down.sql

-- ── organizations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

-- ── organization_memberships ──────────────────────────────────
-- user_id references the existing integer `users.id`.
CREATE TABLE IF NOT EXISTS organization_memberships (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON organization_memberships(user_id);

-- ── companies ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id                 UUID PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  normalized_name    TEXT,
  domain             TEXT,
  normalized_domain  TEXT,
  industry           TEXT,
  size_bucket        TEXT,
  description        TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_companies_org ON companies(org_id);
CREATE INDEX IF NOT EXISTS idx_companies_org_domain ON companies(org_id, normalized_domain);
CREATE INDEX IF NOT EXISTS idx_companies_org_name ON companies(org_id, normalized_name);

-- ── company_locations ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_locations (
  id             UUID PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  address_line   TEXT,
  city           TEXT,
  state          TEXT,
  postal_code    TEXT,
  country        TEXT,
  latitude       NUMERIC,
  longitude      NUMERIC,
  is_primary     BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_company_locations_company ON company_locations(company_id);
CREATE INDEX IF NOT EXISTS idx_company_locations_org ON company_locations(org_id);

-- ── contacts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id                 UUID PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id         UUID REFERENCES companies(id) ON DELETE SET NULL,
  name               TEXT,
  normalized_name    TEXT,
  title              TEXT,
  email              TEXT,
  normalized_email   TEXT,
  phone              TEXT,
  normalized_phone   TEXT,
  source             TEXT,
  opted_out          BOOLEAN NOT NULL DEFAULT false,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(org_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_org_email ON contacts(org_id, normalized_email);
CREATE INDEX IF NOT EXISTS idx_contacts_org_phone ON contacts(org_id, normalized_phone);

-- ── discovery_campaigns ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discovery_campaigns (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  query         TEXT,
  source_type   TEXT NOT NULL DEFAULT 'manual',
  sector        TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_org ON discovery_campaigns(org_id);

-- ── source_records ─────────────────────────────────────────────
-- Raw provenance record for every collected/imported item, whatever the
-- source connector. Deliberately generic — no provider-specific columns.
CREATE TABLE IF NOT EXISTS source_records (
  id             UUID PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id    UUID REFERENCES discovery_campaigns(id) ON DELETE SET NULL,
  source_type    TEXT NOT NULL,
  external_ref   TEXT,
  raw_payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  company_id     UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id     UUID REFERENCES contacts(id) ON DELETE SET NULL,
  legacy_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'collected',
  error          TEXT,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_source_records_org ON source_records(org_id);
CREATE INDEX IF NOT EXISTS idx_source_records_campaign ON source_records(campaign_id);
CREATE INDEX IF NOT EXISTS idx_source_records_company ON source_records(company_id);
CREATE INDEX IF NOT EXISTS idx_source_records_legacy_lead ON source_records(legacy_lead_id);

-- ── opportunities ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opportunities (
  id              UUID PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id      UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  legacy_lead_id  INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  stage           TEXT NOT NULL DEFAULT 'new',
  deal_value      NUMERIC DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'INR',
  owner_team_id   INTEGER REFERENCES team(id) ON DELETE SET NULL,
  campaign_id     UUID REFERENCES discovery_campaigns(id) ON DELETE SET NULL,
  expected_close_date DATE,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_opportunities_org ON opportunities(org_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_company ON opportunities(company_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_legacy_lead ON opportunities(legacy_lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunities_legacy_lead ON opportunities(legacy_lead_id) WHERE legacy_lead_id IS NOT NULL;

-- ── activities (unified timeline, additive — legacy call_logs/lead_notes/
--    reminders keep working independently; this table is for the new
--    company/contact/opportunity graph introduced in this phase) ──
CREATE TABLE IF NOT EXISTS activities (
  id              UUID PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type            TEXT NOT NULL,
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  contact_id      UUID REFERENCES contacts(id) ON DELETE CASCADE,
  opportunity_id  UUID REFERENCES opportunities(id) ON DELETE CASCADE,
  legacy_lead_id  INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activities_org ON activities(org_id);
CREATE INDEX IF NOT EXISTS idx_activities_company ON activities(company_id);
CREATE INDEX IF NOT EXISTS idx_activities_opportunity ON activities(opportunity_id);

-- ── tags ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id         UUID PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT DEFAULT '#5b6af7',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS entity_tags (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('company', 'contact', 'opportunity')),
  entity_id   UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tag_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags(entity_type, entity_id);

-- ── saved_filters ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_filters (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_shared   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_saved_filters_org ON saved_filters(org_id);

-- ── legacy_lead_links ──────────────────────────────────────────
-- Traceability + idempotency anchor for the leads -> companies/opportunities
-- backfill (scripts/backfill-legacy-leads.js). One row per migrated lead.
CREATE TABLE IF NOT EXISTS legacy_lead_links (
  id                UUID PRIMARY KEY,
  legacy_lead_id    INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id        UUID REFERENCES companies(id) ON DELETE SET NULL,
  opportunity_id    UUID REFERENCES opportunities(id) ON DELETE SET NULL,
  source_record_id  UUID REFERENCES source_records(id) ON DELETE SET NULL,
  migrated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── leads: single additive, nullable column ────────────────────
-- Prepares legacy leads for future org-scoping without changing any
-- existing query behavior (nothing reads this column yet).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

-- ── seed the default organization + memberships for existing users ─────
-- Fixed, deterministic UUID so this insert (and the backfill script) is
-- idempotent across repeated runs and across environments.
INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organization', 'default')
ON CONFLICT (id) DO NOTHING;

-- No pgcrypto/uuid-ossp dependency: derive a valid (non-cryptographic) UUID
-- from md5(random..), which every Postgres install can do out of the box.
INSERT INTO organization_memberships (id, org_id, user_id, role)
SELECT (md5(random()::text || clock_timestamp()::text || u.id::text))::uuid,
       '00000000-0000-0000-0000-000000000001', u.id, u.role
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM organization_memberships m
  WHERE m.org_id = '00000000-0000-0000-0000-000000000001' AND m.user_id = u.id
);
