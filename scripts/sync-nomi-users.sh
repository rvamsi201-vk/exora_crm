#!/usr/bin/env bash
# Cron wrapper for the Nomi -> exora_crm user sync.
# Keeps CRM sign-in in step with the Nomi project: a user added in Nomi can
# log into the CRM within the hour, and a Nomi password change follows too.
set -euo pipefail
cd "$(dirname "$0")/.."   # project folder, wherever it lives
mkdir -p logs
LOG=logs/nomi-sync.log
{
  echo "── $(date -Is) ──"
  node scripts/sync-nomi-users.js
} >> "$LOG" 2>&1
# Keep the log from growing without bound.
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
