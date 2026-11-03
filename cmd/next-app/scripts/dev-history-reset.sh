#!/usr/bin/env bash
# Dev only: save one site's energy history to a private snapshot, then delete it,
# so a phone can be watched importing that history from scratch.
#
#   dev-history-reset.sh --database-url <dev-url> --site <site-id> \
#       --expect-name "<site name>" --snapshot <new-directory>
#
# Refuses unless the database carries the dev marker (assert-dev-database.sql),
# the site exists with exactly that name, no import holds the site's lock, and
# the snapshot directory does not exist yet. The snapshot is proved to reload to
# identical rows before anything is deleted, in the same transaction. Only the
# site's day records and summaries are deleted; the site, its owner's
# credentials, rate plans and every other site stay. Undo with
# dev-history-restore.sh. See scripts/dev-history-reset.md.
set -euo pipefail

usage() {
  echo "Usage: $0 --database-url <dev-url> --site <site-id> --expect-name <name> --snapshot <new-directory>" >&2
  exit 2
}

url='' site='' name='' snapshot=''
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --database-url) url="$2" ;;
    --site) site="$2" ;;
    --expect-name) name="$2" ;;
    --snapshot) snapshot="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[[ -n "$url" && -n "$site" && -n "$name" && -n "$snapshot" ]] || usage

script_dir="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=dev-history-common.sh
source "$script_dir/dev-history-common.sh"

if [[ -e "$snapshot" ]]; then
  echo "Refusing: $snapshot already exists. Snapshots are never overwritten." >&2
  exit 1
fi
dev_history_refuse_tracked_path "$snapshot"
mkdir -p "$(dirname "$snapshot")"
mkdir -m 700 "$snapshot"
snapshot="$(cd "$snapshot" && pwd)"

if ! (cd "$snapshot" && psql "$url" -X -q -v ON_ERROR_STOP=1 \
      -v site="$site" -v expect_name="$name" -v project_ref="$(dev_history_project_ref "$url")" \
      -f "$script_dir/dev-history-snapshot.sql"); then
  # The manifest is written just before the delete. Without it the transaction
  # never reached the delete, so the partial files can go. With it the outcome
  # of a lost COMMIT is unknown, so the snapshot stays.
  if [[ ! -s "$snapshot/manifest.json" ]]; then
    rm -rf "$snapshot"
    echo "Reset refused or failed; nothing was deleted." >&2
  else
    chmod 600 "$snapshot"/*
    echo "Reset failed near its end. Check the site's history; if it is gone, restore from $snapshot." >&2
  fi
  exit 1
fi
chmod 600 "$snapshot"/*

echo "Deleted the history of site $site ($name). Snapshot: $snapshot"
echo "Restore with: $script_dir/dev-history-restore.sh --database-url <dev-url> --site $site --snapshot $snapshot"
