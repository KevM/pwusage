#!/usr/bin/env bash
set -euo pipefail
# Synthetic local database only. Never load .env or use DATABASE_URL / DEV_DATABASE_URL.
devcopy_pg_bin="${DEV_COPY_PG_BIN:-$(pg_config --bindir)}"
devcopy_tmp_root=/tmp
if [[ -d /private/tmp ]]; then devcopy_tmp_root=/private/tmp; fi
devcopy_socket="$(mktemp -d "$devcopy_tmp_root/dev-copy-pg-XXXXXXXX")"
chmod 700 "$devcopy_socket"
devcopy_started=false
cleanup() {
  if [[ "$devcopy_started" == true ]]; then "$devcopy_pg_bin/pg_ctl" -D "$devcopy_socket/data" -m fast -w stop >/dev/null; fi
  rm -rf "$devcopy_socket"
}
trap cleanup EXIT
"$devcopy_pg_bin/initdb" -D "$devcopy_socket/data" -A trust --no-locale -E UTF8 >"$devcopy_socket/init.log"
# macOS Postgres aborts at startup ("became multithreaded") without a valid locale.
LC_ALL=C "$devcopy_pg_bin/pg_ctl" -D "$devcopy_socket/data" -l "$devcopy_socket/server.log" -o "-k $devcopy_socket -p 55442 -h ''" -w start >/dev/null
devcopy_started=true
export DEV_COPY_TEST_SOCKET="$devcopy_socket"
export PATH="$devcopy_pg_bin:$PATH"
npm test -- --run scripts/dev-copy-scripts.test.ts
