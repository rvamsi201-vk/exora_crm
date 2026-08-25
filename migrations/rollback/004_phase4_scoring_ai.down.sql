-- Manual rollback for 004_phase4_scoring_ai.sql.
-- Not auto-run — review and run by hand if needed.

DROP TABLE IF EXISTS company_research;
DROP TABLE IF EXISTS company_scores;

DELETE FROM schema_migrations WHERE filename = '004_phase4_scoring_ai.sql';
