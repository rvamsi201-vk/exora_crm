-- City/area-based lead search.
-- Purely additive: new nullable columns on leads, discovery_campaigns, and
-- company_locations. Nothing existing is renamed, dropped, or backfilled
-- destructively — every column defaults to NULL, so rows created before
-- this migration (and searches that don't supply a location) are
-- unaffected.
--
-- Rollback: migrations/rollback/007_location_search.down.sql

ALTER TABLE leads ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS normalized_location TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_city ON leads(city);
CREATE INDEX IF NOT EXISTS idx_leads_normalized_location ON leads(normalized_location);

ALTER TABLE discovery_campaigns ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE discovery_campaigns ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE discovery_campaigns ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE discovery_campaigns ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE discovery_campaigns ADD COLUMN IF NOT EXISTS normalized_location TEXT;

-- company_locations already has city/state/country/postal_code (Phase 1);
-- this adds the finer-grained "area" (locality within a city, e.g.
-- "Koramangala" within "Bengaluru") plus normalized variants for matching.
ALTER TABLE company_locations ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE company_locations ADD COLUMN IF NOT EXISTS normalized_city TEXT;
ALTER TABLE company_locations ADD COLUMN IF NOT EXISTS normalized_area TEXT;
