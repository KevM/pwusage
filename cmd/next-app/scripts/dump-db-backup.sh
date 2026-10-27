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

# pg_dump uses session settings. Keep it off the application's transaction
# pool, where those settings can leak into unrelated requests. Direct and local
# connections are left alone; Supavisor's session listener uses port 5432.
DATABASE_URL="$(node -e '
  const source = process.env.DATABASE_URL;
  const url = new URL(source);
  if (url.hostname.endsWith(".pooler.supabase.com") && url.port === "6543") {
    url.port = "5432";
    process.stdout.write(url.toString());
  } else {
    process.stdout.write(source);
  }
')"
export DATABASE_URL

# Rejects an unknown kind before anything is dumped.
npx tsx scripts/db-backup-kinds.ts "$kind" folder >/dev/null
mkdir -p "$out"
printf 'kind=%s\ntaken_at=%s\n' "$kind" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/backup-info"
supabase db dump --db-url "$DATABASE_URL" -f "$out/roles.sql" --role-only
supabase db dump --db-url "$DATABASE_URL" -f "$out/schema.sql"
# Back up application data only. The CLI's default data dump also includes
# managed auth/storage tables that postgres cannot restore on hosted Supabase.
supabase db dump --db-url "$DATABASE_URL" -f "$out/data.sql" --data-only --use-copy --schema public
npx tsx scripts/verify-db-backup.ts "$out"
