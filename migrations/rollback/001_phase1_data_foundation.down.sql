-- Manual rollback for 001_phase1_data_foundation.sql.
-- Not auto-run by migrations/run.js — review and run by hand if needed.
-- Safe: only touches tables introduced in that migration, plus the
-- single nullable `leads.org_id` column it added. No legacy data is read
-- or written here.

ALTER TABLE IF EXISTS leads DROP COLUMN IF EXISTS org_id;

DROP TABLE IF EXISTS legacy_lead_links;
DROP TABLE IF EXISTS saved_filters;
DROP TABLE IF EXISTS entity_tags;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS opportunities;
DROP TABLE IF EXISTS source_records;
DROP TABLE IF EXISTS discovery_campaigns;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS company_locations;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS organization_memberships;
DROP TABLE IF EXISTS organizations;

DELETE FROM schema_migrations WHERE filename = '001_phase1_data_foundation.sql';
