#!/usr/bin/env bash
set -euo pipefail
# Synthetic tests only: intentionally do not load .env or use DATABASE_URL.
archive_pg_bin="${COMPACT_HISTORY_PG_BIN:-$(pg_config --bindir)}"
archive_pg_major="$($archive_pg_bin/postgres --version | sed -E 's/.* ([0-9]+).*/\1/')"
if [[ "$archive_pg_major" -lt 17 ]]; then
  echo 'Compact history tests require PostgreSQL 17+' >&2
  exit 1
fi
archive_tmp_root=/tmp
if [[ -d /private/tmp ]]; then archive_tmp_root=/private/tmp; fi
archive_socket="$(mktemp -d "$archive_tmp_root/compact-energy-pg-XXXXXXXX")"
chmod 700 "$archive_socket"
archive_started=false
cleanup() {
  if [[ "$archive_started" == true ]]; then
    "$archive_pg_bin/pg_ctl" -D "$archive_socket/data" -m fast -w stop >/dev/null
  fi
  rm -rf "$archive_socket"
}
trap cleanup EXIT
"$archive_pg_bin/initdb" -D "$archive_socket/data" -A trust --no-locale -E UTF8 >"$archive_socket/init.log"
"$archive_pg_bin/pg_ctl" -D "$archive_socket/data" -l "$archive_socket/server.log" \
  -o "-k $archive_socket -p 55439 -h ''" -w start >/dev/null
archive_started=true
export COMPACT_HISTORY_TEST_SOCKET="$archive_socket"
export USER="$(id -un)"
npm test -- --run "$@"
