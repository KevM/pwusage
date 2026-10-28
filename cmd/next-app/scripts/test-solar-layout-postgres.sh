#!/usr/bin/env bash
set -euo pipefail
pg_bin="$(pg_config --bindir)"
tmp_root=/tmp
if [[ -d /private/tmp ]]; then tmp_root=/private/tmp; fi
socket="$(mktemp -d "$tmp_root/solar-layout-pg-XXXXXXXX")"
started=false
cleanup() {
  if [[ "$started" == true ]]; then "$pg_bin/pg_ctl" -D "$socket/data" -m fast -w stop >/dev/null; fi
  rm -rf "$socket"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$socket/data" -A trust --no-locale -E UTF8 >"$socket/init.log"
LC_ALL=C "$pg_bin/pg_ctl" -D "$socket/data" -l "$socket/server.log" -o "-k $socket -p 55443 -h ''" -w start >/dev/null
started=true
export SOLAR_TEST_SOCKET="$socket"
npm test -- --run scripts/solar-layout-postgres.test.ts
