-- Manual rollback for 003_phase3_enrichment_dedup.sql.
-- Not auto-run — review and run by hand if needed.

ALTER TABLE IF EXISTS contacts DROP COLUMN IF EXISTS merged_into;
ALTER TABLE IF EXISTS contacts DROP COLUMN IF EXISTS phone_verified;
ALTER TABLE IF EXISTS contacts DROP COLUMN IF EXISTS email_verified;

ALTER TABLE IF EXISTS companies DROP COLUMN IF EXISTS merged_into;
ALTER TABLE IF EXISTS companies DROP COLUMN IF EXISTS enriched_at;

DROP TABLE IF EXISTS entity_merges;
DROP TABLE IF EXISTS duplicate_candidates;

DELETE FROM schema_migrations WHERE filename = '003_phase3_enrichment_dedup.sql';
