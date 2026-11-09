#!/usr/bin/env bash
set -euo pipefail
# Disposable local PostgreSQL only; never load .env or DATABASE_URL.
pg_bin="${SITE_MEMBERSHIP_PG_BIN:-$(pg_config --bindir)}"
test_root=/private/tmp
socket="$(mktemp -d "$test_root/site-membership-pg-XXXXXXXX")"
chmod 700 "$socket"
started=false
cleanup() {
  if [[ "$started" == true ]]; then "$pg_bin/pg_ctl" -D "$socket/data" -m fast -w stop >/dev/null; fi
  rm -rf "$socket"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$socket/data" -A trust --no-locale -E UTF8 >"$socket/init.log"
"$pg_bin/pg_ctl" -D "$socket/data" -l "$socket/server.log" -o "-k $socket -p 55453 -h ''" -w start >/dev/null
started=true
export SITE_MEMBERSHIP_TEST_SOCKET="$socket"
npm test -- --run src/lib/site-membership-postgres.test.ts "$@"
