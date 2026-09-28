# exora_crm — production deployment

Live at **https://crm.exora.solutions** (Express + PostgreSQL, behind nginx, run by PM2).

## Topology

```
Cloudflare  →  nginx :443 (Let's Encrypt)  →  127.0.0.1:3002  →  server.js
                                                                    ├── PostgreSQL  10.0.0.1:5432/exora_crm  (all CRM data)
                                                                    └── SQLite      /var/www/Nomi           (users, read-only)
```

`server.js` serves both the API (`/api/*`, `/webhook/*`) and the single-page UI
(`index.html`) from the same origin, so the frontend's
`window.location.origin + '/api'` base URL needs no build step.

## Authentication — Nomi is the only user directory

The Nomi project (`/var/www/Nomi`) is the **sole** source of CRM accounts.
Everything else — leads, companies, opportunities, tasks, analytics — lives in
this app's own `exora_crm` PostgreSQL database.

Accounts are not created, renamed, re-roled, or password-changed here. The CRM
holds a read-only projection of Nomi's directory, and `server.js` enforces it:
`POST /api/auth/register` and `PUT /api/auth/update` both return 405 pointing
the caller at Nomi. A second write path would let the two drift — an account
made here would have no Nomi identity and no role Nomi could correct.

| In the CRM | Comes from |
|---|---|
| name, email, password | `User.name` / `User.email` / `User.passwordHash` |
| role | `OrgMember.role` — `admin` → admin, `member` → salesperson |
| access | presence in `User`; removal disables the CRM account |

Roles are **not** configured in this app. An earlier version assigned them from
a `NOMI_ADMIN_EMAILS` env list, which got them wrong (it made a Nomi admin a
salesperson here). Nomi's own org membership decides.

Nomi hashes passwords with bcryptjs at cost 10 (`lib/auth.ts:90`), producing
`$2b$10$…` hashes that this app's `bcrypt.compare` reads directly. Passwords
therefore carry over as-is — nobody has to reset anything.

`scripts/sync-nomi-users.js` copies them across. It is idempotent and safe to
re-run:

```bash
cd /var/www/exora_crm
node scripts/sync-nomi-users.js --dry-run    # report, change nothing
node scripts/sync-nomi-users.js              # apply
node scripts/sync-nomi-users.js --prune      # hard-delete instead of disabling
```

For each Nomi user it upserts a row in `users` (carrying the bcrypt hash
verbatim), stamps `users.nomi_user_id` with the Nomi cuid, creates the matching
`team` row the UI reads from, and adds an `organization_memberships` row in the
default org.

Details worth knowing:

- Nomi's SQLite file is opened **read-only** through the `sqlite3` CLI, so the
  live Nomi database is never written to and no native driver is needed.
- **Nomi wins, always.** A role edited directly in the CRM database is corrected
  on the next run. That is the point, not a limitation.
- Someone removed from Nomi is **disabled**, not deleted: `users.disabled_at` is
  stamped and login returns 403, while their calls, notes and activity stay
  attributable. Put them back in Nomi and the next sync re-enables them.
  `--prune` hard-deletes instead, if that is ever wanted.
- The whole sync runs in one transaction, and aborts without writing if Nomi
  reports zero users.

A cron entry re-runs it hourly, so a person added in Nomi can sign into the CRM
within the hour:

```
23 * * * * /var/www/exora_crm/scripts/sync-nomi-users.sh   # logs to logs/nomi-sync.log
```

## Database

Database `exora_crm` on the **shared database server `10.0.0.1:5432`** — the
same host loomrun, qlix, sona, sunkidz_lms and n8n use. Nothing for this app is
stored in the web server's local PostgreSQL.

It is owned by a dedicated non-superuser role `exora_crm` rather than the shared
`postgres` superuser the other databases there use. On a host holding six
unrelated applications' data, that is the difference between a leaked CRM
credential exposing one database and it exposing all of them.

**`DATABASE_SSL_MODE=disable` is required here, and only here.** `10.0.0.1` runs
with `ssl = off`, so `require` fails the handshake outright. Traffic crosses a
private network between the two machines, not the public internet.

Credential lives in `/root/.exora_crm_pgpw` (mode 600) as well as `.env`.

Schema comes from two places: the base tables (`leads`, `team`, `users`,
`call_logs`, `lead_notes`, `reminders`, `score_config`, `domains`) are created
by `initDB()` in `server.js`, and everything from Phase 1 onward is in
`migrations/`.

`AUTO_INIT_DB=false` in production — `initDB()` never runs against the live
database. Apply schema changes explicitly:

```bash
cd /var/www/exora_crm
npm run migrate:status                  # what's applied / pending
BACKUP_CONFIRMED=true npm run migrate   # apply (take a backup first)

# Backup / connect. The local `psql` is 16.x and 10.0.0.1 runs 15.x, so a dump
# taken here restores to the remote only in the 15→15 direction — dump *from*
# the remote, never from a newer local instance into it.
pg_dump "$DATABASE_URL" -F c -f backup_$(date +%Y%m%d%H%M%S).dump
psql -h 10.0.0.1 -U exora_crm -d exora_crm
```

## Process management

```bash
pm2 restart exora-crm
pm2 logs exora-crm --lines 50
pm2 save                                # persist after changing the process list
```

`ecosystem.config.js` deliberately declares **no `env` block**: `.env` is the
single source of truth, and PM2 env values would silently win over it because
dotenv never overwrites a variable already present in the environment.

`server.js` binds `127.0.0.1` by default (`HOST` overrides it). This matters —
there is no firewall on this host, so binding `0.0.0.0` would publish the entire
API over plain HTTP on the public interface, bypassing the certificate.

## nginx & TLS

Config: `/etc/nginx/sites-available/crm.exora.solutions` (symlinked into
`sites-enabled`). `/api/` gets a 300s read timeout because discovery runs drive
Puppeteer and AI research jobs that outlast the 60s default.

```bash
nginx -t && systemctl reload nginx
```

TLS is a Let's Encrypt ECDSA certificate renewed by `certbot.timer` using the
nginx authenticator; `/.well-known/acme-challenge/` is also served from
`/var/www/certbot` on both :80 and :443 as a fallback.

```bash
certbot certificates --cert-name crm.exora.solutions
certbot renew --cert-name crm.exora.solutions --dry-run
```

## Configuration

`.env` (mode 600, gitignored) holds `JWT_SECRET`, `DATABASE_URL`, the Nomi sync
settings (`NOMI_DB_PATH`, `NOMI_ADMIN_EMAILS`), and the optional integration
keys. `.env.example` documents every variable.

Optional integrations are unset, which is a safe default, not an oversight:
`AI_PROVIDER` unset means research jobs complete as `skipped` rather than
calling a paid API, and with no outreach provider configured all sends are
recorded as `simulated` with no network call.


## Roles and what each can do

Derived from Nomi (`OrgMember.role`), not set here.

| | Admin | Salesperson |
|---|---|---|
| Generate leads (`/api/trigger-all`) | yes | yes |
| Create a sector (`POST /api/domains`) | yes | yes |
| Rename / delete a sector | yes | no |
| Table-wide dedup (`/api/leads/dedup`) | yes | no |
| Delete leads, manage team, analytics | yes | no |

**Salespeople own what they source.** Leads generated by a salesperson are
assigned to them automatically (`assigned_id` = their `team` row, `assigned_at`
stamped), so they land in "My Leads" without an admin handing them over. Leads
an *admin* generates deliberately stay unassigned, so the existing distribution
flow still works.

## Interface

Swiss / International Typographic Style, applied platform-wide. The rules, and
where they live in `index.html`:

- **One neutral grotesque** (Inter, with a Helvetica/Arial fallback). The old
  build mixed Syne, DM Sans, Press Start 2P and an unloaded Clash Display.
- **Achromatic ground** — black, white, a six-step grey ramp, and exactly one
  accent (red `#e1000f`) for the primary action and the active nav item.
  Status colours are kept only where they encode data.
- **No radius, no shadow, no gradient.** Structure is hairline rules and space,
  on an 8px grid.
- **Tabular numerals** everywhere figures are compared down a column.

Design tokens are the `:root` block near the top of the `<style>`. Legacy
variable names (`--acc`, `--s1..--s3`, `--tx..--tx3`, `--bd`, `--r`) are
deliberately preserved and remapped, because ~3,000 lines of component CSS
reference them — changing the values there re-skins the platform coherently.
The `SWISS LAYER` and the layers after it load last and settle the shared
language.

Removed along the way, as ornament this style has no use for: a rotating
"vortex" canvas and a particle field on the landing page (the vortex rendered
*over* the headline), a typewriter animation that retyped the wordmarks every
two seconds and left them clipped mid-word, and ~120 decorative emoji. The
emoji→Lucide icon map in the sector picker is functional and was kept.


## Location handling in lead discovery

People do not fill the Area and City boxes the way the labels imply. The whole
location goes into City, or into Area, with or without commas, using whichever
name for the city they grew up with. The system is built to absorb that rather
than punish it.

**1. Parse, then search.** `parseLocationInput()` (lib/normalize.js) resolves
whatever was typed, in whichever box, into a structured `{area, city, state,
country}`. The city is the first term that is a recognised city name; failing
that, the last term, because addresses run narrowest-first. Everything else
becomes the area. A correctly-filled pair of boxes passes through untouched.

    typed   {"city": "vasanth nagar bangalore"}
    parsed  {"area": "vasanth nagar", "city": "bangalore"}
    serper  "gym in vasanth nagar, bangalore"

The same parsed structure is used for the search text *and* for grading the
results, so the two can never disagree.

**2. Grade, don't discard.** `locationMatches()` returns a confidence rather
than a verdict:

| confidence | meaning | outcome |
|---|---|---|
| `exact` | neighbourhood matched too | saved |
| `city` | right city, different or unstated neighbourhood | **saved**, counted as "just outside the area" |
| `matches: false` | wrong city / state / country | rejected |

Only a wrong *city* rejects. That gate is what keeps a US or UK listing out of
an Indian search, and it stays. A neighbourhood mismatch does not reject:
the discovery source already judged the result relevant, many valid Google
addresses omit the locality entirely, and discarding those leaves a salesperson
with nothing to show for a search that worked. The run reports
`pipeline.outside_area` so the leniency is visible rather than silent.

Terms are matched on word boundaries with alias expansion (`bengaluru` ↔
`bangalore`, `mumbai` ↔ `bombay`, …), so "Vasantha Vallabha Nagar" does not
count as a hit for "Vasanth Nagar".

**Why this exists.** A production run on 2026-08-26 returned 20 Serper results
and saved **zero** — the City field held `"vasanth nagar bangalore"` and was
matched as one literal string against addresses reading "Vasanth Nagar,
Bengaluru". Two failures at once: no term splitting, and the city alias only
fired on an exact whole-field match. The same 20 results now save, 10 of them
flagged as outside the exact area. `test/normalize.test.js` pins this.
