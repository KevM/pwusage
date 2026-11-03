#!/usr/bin/env bash
set -euo pipefail
# Synthetic local database only. Never load .env or use DATABASE_URL / DEV_DATABASE_URL.
devhistory_pg_bin="${DEV_HISTORY_PG_BIN:-$(pg_config --bindir)}"
devhistory_tmp_root=/tmp
if [[ -d /private/tmp ]]; then devhistory_tmp_root=/private/tmp; fi
devhistory_socket="$(mktemp -d "$devhistory_tmp_root/dev-history-pg-XXXXXXXX")"
chmod 700 "$devhistory_socket"
devhistory_started=false
cleanup() {
  if [[ "$devhistory_started" == true ]]; then "$devhistory_pg_bin/pg_ctl" -D "$devhistory_socket/data" -m fast -w stop >/dev/null; fi
  rm -rf "$devhistory_socket"
}
trap cleanup EXIT
"$devhistory_pg_bin/initdb" -D "$devhistory_socket/data" -A trust --no-locale -E UTF8 >"$devhistory_socket/init.log"
# macOS Postgres aborts at startup ("became multithreaded") without a valid locale.
LC_ALL=C "$devhistory_pg_bin/pg_ctl" -D "$devhistory_socket/data" -l "$devhistory_socket/server.log" -o "-k $devhistory_socket -p 55443 -h ''" -w start >/dev/null
devhistory_started=true
export DEV_HISTORY_TEST_SOCKET="$devhistory_socket"
export PATH="$devhistory_pg_bin:$PATH"
npm test -- --run scripts/dev-history-scripts.test.ts
