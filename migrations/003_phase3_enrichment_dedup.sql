-- Phase 3: Enrichment and deduplication.
-- Purely additive: two new tables (duplicate_candidates, entity_merges),
-- plus nullable columns on companies/contacts. No existing table is
-- dropped, renamed, or destructively converted.
--
-- Rollback: migrations/rollback/003_phase3_enrichment_dedup.down.sql

-- ── duplicate_candidates ─────────────────────────────────────────
-- One row per candidate pair found by a dedup scan. entity_id_a is always
-- the lexicographically smaller UUID so (entity_type, entity_id_a,
-- entity_id_b) is a stable, unique key regardless of scan order.
CREATE TABLE IF NOT EXISTS duplicate_candidates (
  id             UUID PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('company', 'contact')),
  entity_id_a    UUID NOT NULL,
  entity_id_b    UUID NOT NULL,
  confidence     NUMERIC(4,3) NOT NULL,
  reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'auto_merged', 'confirmed', 'rejected')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  resolved_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (entity_type, entity_id_a, entity_id_b)
);
CREATE INDEX IF NOT EXISTS idx_dup_candidates_org_status ON duplicate_candidates(org_id, status);

-- ── entity_merges ─────────────────────────────────────────────────
-- Immutable audit log of every merge (auto or reviewed). The loser record
-- itself is never deleted (see companies/contacts.merged_into below), so
-- this plus the merged_into pointer is the "rollback" trail for a merge.
CREATE TABLE IF NOT EXISTS entity_merges (
  id           UUID PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('company', 'contact')),
  winner_id    UUID NOT NULL,
  loser_id     UUID NOT NULL,
  confidence   NUMERIC(4,3),
  reasons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  auto         BOOLEAN NOT NULL DEFAULT false,
  merged_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entity_merges_org ON entity_merges(org_id);
CREATE INDEX IF NOT EXISTS idx_entity_merges_loser ON entity_merges(entity_type, loser_id);

-- ── companies / contacts: additive enrichment + merge columns ─────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS idx_companies_merged_into ON companies(merged_into);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES contacts(id);
CREATE INDEX IF NOT EXISTS idx_contacts_merged_into ON contacts(merged_into);
