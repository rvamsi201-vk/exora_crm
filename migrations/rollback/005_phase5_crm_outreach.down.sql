-- Manual rollback for 005_phase5_crm_outreach.sql.
-- Not auto-run — review and run by hand if needed.

DROP TABLE IF EXISTS outreach_messages;
DROP TABLE IF EXISTS suppressions;
DROP TABLE IF EXISTS tasks;
ALTER TABLE IF EXISTS opportunities DROP COLUMN IF EXISTS assigned_at;

DELETE FROM schema_migrations WHERE filename = '005_phase5_crm_outreach.sql';
