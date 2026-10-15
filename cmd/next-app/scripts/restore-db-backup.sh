#!/usr/bin/env bash
# Restores a backup made by .github/workflows/db-backup.yml into an EMPTY database.
#
#   restore-db-backup.sh --target <postgres-url> --full <backup.zip|dir> [--daily <backup.zip|dir>]
#
# --full is a weekly or pre-migration backup. --daily, when given, must be newer:
# the schema and every table except EnergyData come from it, EnergyData history
# comes from --full (dropping rows for sites that no longer exist), and the
# daily backup's recent readings replace any overlapping history.
#
# Safety: it refuses any target whose public schema already has tables, so it
# cannot overwrite prod, dev or anything else. Everything loads in a single
# transaction, so a failure leaves the target empty. See docs/database-backups.md.
set -euo pipefail

usage() {
  echo "Usage: $0 --target <postgres-url> --full <backup.zip|dir> [--daily <backup.zip|dir>]" >&2
  exit 2
}

target='' full='' daily=''
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --target) target="$2" ;;
    --full) full="$2" ;;
    --daily) daily="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[[ -n "$target" && -n "$full" ]] || usage

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Accepts a backup zip or an already unpacked directory; prints the directory.
unpack() {
  local source="$1" name="$2"
  if [[ -d "$source" ]]; then (cd "$source" && pwd); return; fi
  if [[ ! -f "$source" ]]; then echo "Backup not found: $source" >&2; return 1; fi
  mkdir "$work/$name"
  unzip -q "$source" -d "$work/$name"
  echo "$work/$name"
}

require() {
  local dir="$1"; shift
  for file in "$@"; do
    if [[ ! -s "$dir/$file" ]]; then echo "Backup in $dir is missing or has an empty $file" >&2; return 1; fi
  done
}

full_dir="$(unpack "$full" full)" || exit 1
require "$full_dir" roles.sql schema.sql data.sql || exit 1
newest_dir="$full_dir"
if [[ -n "$daily" ]]; then
  daily_dir="$(unpack "$daily" daily)" || exit 1
  require "$daily_dir" roles.sql schema.sql data.sql energy-recent.csv || exit 1
  newest_dir="$daily_dir"
fi

psql_target=(psql "$target" -X -q -v ON_ERROR_STOP=1)
tables="$("${psql_target[@]}" -A -t -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if [[ "$tables" != 0 ]]; then
  echo "Refusing to restore: the target database already has tables in its public schema ($tables)." >&2
  echo "Restore into a new, empty database instead." >&2
  exit 1
fi

files=(-f "$newest_dir/roles.sql" -f "$newest_dir/schema.sql" -f "$newest_dir/data.sql")
if [[ -n "$daily" ]]; then
  # Pull the full backup's EnergyData block out, aimed at a staging table.
  awk '
    !copying && /^COPY ("?public"?\.)?"?EnergyData"? / { copying = 1; sub(/^COPY [^ ]+ /, "COPY pg_temp.energy_weekly "); print; next }
    copying { print; if ($0 == "\\.") copying = 0 }
  ' "$full_dir/data.sql" > "$work/energy-weekly.sql"
  if [[ ! -s "$work/energy-weekly.sql" ]]; then
    echo "The full backup has no EnergyData to combine with the daily backup" >&2
    exit 1
  fi
  columns="$(head -n 1 "$daily_dir/energy-recent.csv" | tr -d '\r' | sed 's/[^,][^,]*/"&"/g')"
  # Triggers stay paused (as the dump's own data load does), so restored rows
  # reproduce the snapshot instead of invalidating archived days while loading.
  cat > "$work/merge-energy.sql" <<SQL
SET session_replication_role = replica;
CREATE TEMP TABLE energy_weekly (LIKE public."EnergyData" INCLUDING DEFAULTS) ON COMMIT DROP;
\i '$work/energy-weekly.sql'
INSERT INTO public."EnergyData"
SELECT w.* FROM energy_weekly w
WHERE EXISTS (SELECT 1 FROM public."Site" s WHERE s.id = w.site_id)
ON CONFLICT DO NOTHING;
CREATE TEMP TABLE energy_recent (LIKE public."EnergyData" INCLUDING DEFAULTS) ON COMMIT DROP;
\copy energy_recent ($columns) FROM '$daily_dir/energy-recent.csv' WITH (FORMAT csv, HEADER true)
DELETE FROM public."EnergyData" e USING energy_recent r
WHERE e."timestamp" = r."timestamp" AND e.site_id = r.site_id;
INSERT INTO public."EnergyData"
SELECT r.* FROM energy_recent r
WHERE EXISTS (SELECT 1 FROM public."Site" s WHERE s.id = r.site_id);
SQL
  files+=(-f "$work/merge-energy.sql")
fi

"${psql_target[@]}" --single-transaction "${files[@]}"

echo "Rows restored:"
"${psql_target[@]}" -A -t -F ': ' -c "
  SELECT 'User', count(*) FROM public.\"User\"
  UNION ALL SELECT 'Site', count(*) FROM public.\"Site\"
  UNION ALL SELECT 'EnergyData', count(*) FROM public.\"EnergyData\""
echo "Restore complete."
