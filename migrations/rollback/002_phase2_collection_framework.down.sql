-- Manual rollback for 002_phase2_collection_framework.sql.
-- Not auto-run — review and run by hand if needed.

ALTER TABLE IF EXISTS source_records DROP COLUMN IF EXISTS run_id;
ALTER TABLE IF EXISTS source_records DROP COLUMN IF EXISTS retry_count;

DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS campaign_runs;

DELETE FROM schema_migrations WHERE filename = '002_phase2_collection_framework.sql';
