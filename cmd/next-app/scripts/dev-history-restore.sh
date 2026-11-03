#!/usr/bin/env bash
# Dev only: put back a site's energy history saved by dev-history-reset.sh.
#
#   dev-history-restore.sh --database-url <dev-url> --site <site-id> --snapshot <directory> \
#       [--preview | --replace | --keep-newer]
#
# Validates the dev marker, that the snapshot belongs to this site, database and
# schema, and that its files match manifest.json, then restores in one
# transaction and checks the result. When the site has imported history since
# the reset, it refuses unless you choose:
#   --replace     discard the newer records and return exactly to the snapshot
#   --keep-newer  keep the newer records and restore only the missing days
# --preview reports what would happen and changes nothing.
# See scripts/dev-history-reset.md.
set -euo pipefail

usage() {
  echo "Usage: $0 --database-url <dev-url> --site <site-id> --snapshot <directory> [--preview | --replace | --keep-newer]" >&2
  exit 2
}

url='' site='' snapshot='' mode='only-if-empty'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --preview) mode='preview'; shift; continue ;;
    --replace) mode='replace'; shift; continue ;;
    --keep-newer) mode='keep-newer'; shift; continue ;;
  esac
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --database-url) url="$2" ;;
    --site) site="$2" ;;
    --snapshot) snapshot="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[[ -n "$url" && -n "$site" && -n "$snapshot" ]] || usage

script_dir="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=dev-history-common.sh
source "$script_dir/dev-history-common.sh"

for file in manifest.json archive.csv summary.csv; do
  if [[ ! -s "$snapshot/$file" ]]; then
    echo "Refusing: $snapshot/$file is missing or empty." >&2
    exit 1
  fi
done

if ! (cd "$snapshot" && psql "$url" -X -q -v ON_ERROR_STOP=1 \
      -v site="$site" -v mode="$mode" -v project_ref="$(dev_history_project_ref "$url")" \
      -v manifest="$(cat manifest.json)" \
      -f "$script_dir/dev-history-restore.sql"); then
  echo "Restore refused or failed; nothing changed." >&2
  exit 1
fi
