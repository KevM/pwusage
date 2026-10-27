#!/usr/bin/env bash
# Restores a backup made by .github/workflows/db-backup.yml into an EMPTY database.
#
#   restore-db-backup.sh --target <postgres-url> --backup <backup.zip|dir>
#
# Any backup kind (daily, weekly or pre-migration) is a complete dump, so the
# newest one restores everything.
#
# Safety: it refuses any target whose public schema already has tables, so it
# cannot overwrite prod, dev or anything else. Everything loads in a single
# transaction, so a failure leaves the target empty. See docs/database-backups.md.
set -euo pipefail

usage() {
  echo "Usage: $0 --target <postgres-url> --backup <backup.zip|dir>" >&2
  exit 2
}

target='' backup=''
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --target) target="$2" ;;
    --backup) backup="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[[ -n "$target" && -n "$backup" ]] || usage

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

script_dir="$(cd "$(dirname "$0")" && pwd)"

backup_dir="$(unpack "$backup" backup)" || exit 1
require "$backup_dir" roles.sql schema.sql data.sql || exit 1
# The same checks a backup passes before upload.
npx tsx "$script_dir/verify-db-backup.ts" "$backup_dir" >/dev/null || exit 1

psql_target=(psql "$target" -X -q -v ON_ERROR_STOP=1)
tables="$("${psql_target[@]}" -A -t -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if [[ "$tables" != 0 ]]; then
  echo "Refusing to restore: the target database already has tables in its public schema ($tables)." >&2
  echo "Restore into a new, empty database instead." >&2
  exit 1
fi

"${psql_target[@]}" --single-transaction -o /dev/null \
  -f "$backup_dir/roles.sql" -f "$backup_dir/schema.sql" -f "$backup_dir/data.sql"

echo "Rows restored:"
"${psql_target[@]}" -A -t -F ': ' -c "
  SELECT 'User', count(*) FROM public.\"User\"
  UNION ALL SELECT 'Site', count(*) FROM public.\"Site\"
  UNION ALL SELECT 'EnergyDayArchive', count(*) FROM public.\"EnergyDayArchive\""
echo "Restore complete."
