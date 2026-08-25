-- Manual rollback for 006_phase6_analytics.sql.
-- Not auto-run — review and run by hand if needed.

DROP TABLE IF EXISTS score_feedback;
ALTER TABLE IF EXISTS opportunities DROP COLUMN IF EXISTS lost_reason;

DELETE FROM schema_migrations WHERE filename = '006_phase6_analytics.sql';
