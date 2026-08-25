# Migrations

Additive-only SQL files, applied in filename order and tracked in a
`schema_migrations` table. Nothing here runs automatically at server
startup — `server.js`'s existing `initDB()` bootstrap is untouched and
keeps working as before.

## Before running against a real database

**Take a backup first:**

```
pg_dump "$DATABASE_URL" -F c -f backup_$(date +%Y%m%d%H%M%S).dump
```

Restore with: `pg_restore -d "$DATABASE_URL" backup_<timestamp>.dump`

Against `NODE_ENV=production`, `migrations/run.js` and
`scripts/backfill-legacy-leads.js --apply` both refuse to run unless
`BACKUP_CONFIRMED=true` is set, so a backup is a deliberate, explicit step,
not something to forget.

## Usage

```
npm run migrate:status          # list applied / pending, no writes
npm run migrate                 # apply pending migrations
npm run backfill:legacy-leads          # dry run — counts only, no writes
npm run backfill:legacy-leads -- --apply
```

## Rollback

Each migration's manual rollback lives in `migrations/rollback/<name>.down.sql`.
These are not auto-run — review them and apply by hand:

```
psql "$DATABASE_URL" -f migrations/rollback/001_phase1_data_foundation.down.sql
```

`001_phase1_data_foundation.sql` only adds new tables plus one nullable
`leads.org_id` column, so its rollback is a straightforward set of
`DROP TABLE IF EXISTS` / `DROP COLUMN IF EXISTS` statements — it never
deletes or modifies `leads`, `users`, `team`, or any other pre-existing row.

## Testing

`test/migration.test.js` runs the real migration and backfill script
against a disposable `postgres:16-alpine` Docker container (never against
`DATABASE_URL`), and skips itself if Docker isn't available.
