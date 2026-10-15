#!/usr/bin/env bash
# Dumps $DATABASE_URL into <outdir> for a backup kind (see db-backup-kinds.ts)
# and verifies the result. Used by .github/workflows/db-backup.yml; read-only
# against the source database.
#
#   DATABASE_URL=... dump-db-backup.sh <kind> <outdir>
set -euo pipefail
kind="${1:?Usage: dump-db-backup.sh <kind> <outdir>}"
out="${2:?Usage: dump-db-backup.sh <kind> <outdir>}"
: "${DATABASE_URL:?DATABASE_URL is required}"

dump="$(npx tsx scripts/db-backup-kinds.ts "$kind" dump)"
mkdir -p "$out"
# Restores use this to refuse a daily backup that is not newer than the full one.
printf 'kind=%s\ndump=%s\ntaken_at=%s\n' "$kind" "$dump" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/backup-info"
supabase db dump --db-url "$DATABASE_URL" -f "$out/roles.sql" --role-only
supabase db dump --db-url "$DATABASE_URL" -f "$out/schema.sql"
# Back up application data only. The CLI's default data dump also includes
# managed auth/storage tables that postgres cannot restore on hosted Supabase.
if [[ "$dump" == full ]]; then
  supabase db dump --db-url "$DATABASE_URL" -f "$out/data.sql" --data-only --use-copy --schema public
else
  # EnergyData history is about 90% of a dump and backfillable from Tesla, so
  # daily backups keep only its last three days, in a separate file. Pass the
  # name unquoted: the CLI reads -x as a CSV list, rejects embedded quotes, and
  # quotes the identifier itself (checked against Supabase Postgres 17, CLI
  # 2.120). If the exclusion ever stops working, verify-db-backup.ts rejects the
  # dump instead of uploading it.
  supabase db dump --db-url "$DATABASE_URL" -f "$out/data.sql" --data-only --use-copy --schema public -x public.EnergyData
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "\copy (SELECT * FROM public.\"EnergyData\" WHERE \"timestamp\" >= now() - interval '3 days' ORDER BY \"timestamp\", site_id) TO '$out/energy-recent.csv' WITH (FORMAT csv, HEADER true)"
fi
npx tsx scripts/verify-db-backup.ts "$out" "$dump"
