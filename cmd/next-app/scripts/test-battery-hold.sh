#!/usr/bin/env bash
set -euo pipefail
# Synthetic local database only. Never load .env or use DATABASE_URL.
hold_pg_bin="${BATTERY_HOLD_PG_BIN:-$(pg_config --bindir)}"
hold_tmp_root=/tmp
if [[ -d /private/tmp ]]; then hold_tmp_root=/private/tmp; fi
hold_socket="$(mktemp -d "$hold_tmp_root/battery-hold-pg-XXXXXXXX")"
chmod 700 "$hold_socket"
hold_started=false
cleanup() {
  if [[ "$hold_started" == true ]]; then "$hold_pg_bin/pg_ctl" -D "$hold_socket/data" -m fast -w stop >/dev/null; fi
  rm -rf "$hold_socket"
}
trap cleanup EXIT
"$hold_pg_bin/initdb" -D "$hold_socket/data" -A trust --no-locale -E UTF8 >"$hold_socket/init.log"
"$hold_pg_bin/pg_ctl" -D "$hold_socket/data" -l "$hold_socket/server.log" -o "-k $hold_socket -p 55440 -h ''" -w start >/dev/null
hold_started=true
export BATTERY_HOLD_TEST_SOCKET="$hold_socket"
npm test -- --run src/lib/battery-hold-postgres.test.ts
