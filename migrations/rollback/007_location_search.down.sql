-- Manual rollback for 007_location_search.sql.
-- Not auto-run — review and run by hand if needed.

ALTER TABLE IF EXISTS company_locations DROP COLUMN IF EXISTS normalized_area;
ALTER TABLE IF EXISTS company_locations DROP COLUMN IF EXISTS normalized_city;
ALTER TABLE IF EXISTS company_locations DROP COLUMN IF EXISTS area;

ALTER TABLE IF EXISTS discovery_campaigns DROP COLUMN IF EXISTS normalized_location;
ALTER TABLE IF EXISTS discovery_campaigns DROP COLUMN IF EXISTS country;
ALTER TABLE IF EXISTS discovery_campaigns DROP COLUMN IF EXISTS state;
ALTER TABLE IF EXISTS discovery_campaigns DROP COLUMN IF EXISTS area;
ALTER TABLE IF EXISTS discovery_campaigns DROP COLUMN IF EXISTS city;

ALTER TABLE IF EXISTS leads DROP COLUMN IF EXISTS normalized_location;
ALTER TABLE IF EXISTS leads DROP COLUMN IF EXISTS country;
ALTER TABLE IF EXISTS leads DROP COLUMN IF EXISTS state;
ALTER TABLE IF EXISTS leads DROP COLUMN IF EXISTS area;
ALTER TABLE IF EXISTS leads DROP COLUMN IF EXISTS city;

DELETE FROM schema_migrations WHERE filename = '007_location_search.sql';
