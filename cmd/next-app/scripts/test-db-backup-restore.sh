#!/usr/bin/env bash
set -euo pipefail
# Synthetic local database only. Never load .env or use DATABASE_URL.
restore_pg_bin="${DB_BACKUP_PG_BIN:-$(pg_config --bindir)}"
restore_tmp_root=/tmp
if [[ -d /private/tmp ]]; then restore_tmp_root=/private/tmp; fi
restore_socket="$(mktemp -d "$restore_tmp_root/db-backup-pg-XXXXXXXX")"
chmod 700 "$restore_socket"
restore_started=false
cleanup() {
  if [[ "$restore_started" == true ]]; then "$restore_pg_bin/pg_ctl" -D "$restore_socket/data" -m fast -w stop >/dev/null; fi
  rm -rf "$restore_socket"
}
trap cleanup EXIT
"$restore_pg_bin/initdb" -D "$restore_socket/data" -A trust --no-locale -E UTF8 >"$restore_socket/init.log"
# macOS Postgres aborts at startup ("became multithreaded") without a valid locale.
LC_ALL=C "$restore_pg_bin/pg_ctl" -D "$restore_socket/data" -l "$restore_socket/server.log" -o "-k $restore_socket -p 55441 -h ''" -w start >/dev/null
restore_started=true
export DB_BACKUP_TEST_SOCKET="$restore_socket"
export PATH="$restore_pg_bin:$PATH"
npm test -- --run scripts/restore-db-backup.test.ts
