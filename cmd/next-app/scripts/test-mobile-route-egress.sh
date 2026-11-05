#!/usr/bin/env bash
set -euo pipefail
# Isolated fixture. Never read .env or connect to a hosted database.
cd "$(dirname "$0")/.."
egress_pg_bin="${EGRESS_PG_BIN:-$(pg_config --bindir)}"
egress_tmp_root=/tmp
if [[ -d /private/tmp ]]; then egress_tmp_root=/private/tmp; fi
egress_socket="$(mktemp -d "$egress_tmp_root/mobile-egress-pg-XXXXXXXX")"
chmod 700 "$egress_socket"
egress_started=false
cleanup() {
  if [[ "$egress_started" == true ]]; then "$egress_pg_bin/pg_ctl" -D "$egress_socket/data" -m fast -w stop >/dev/null; fi
  rm -rf "$egress_socket"
}
trap cleanup EXIT
"$egress_pg_bin/initdb" -D "$egress_socket/data" -U egress -A trust --no-locale -E UTF8 >"$egress_socket/init.log"
LC_ALL=C "$egress_pg_bin/pg_ctl" -D "$egress_socket/data" -l "$egress_socket/server.log" -o "-k $egress_socket -p 55447 -h ''" -w start >/dev/null
egress_started=true

egress_psql=("$egress_pg_bin/psql" -h "$egress_socket" -p 55447 -U egress -d postgres -X -v ON_ERROR_STOP=1 -q)
"${egress_psql[@]}" <<'SQL'
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA pwusage_env;
CREATE TABLE pwusage_env.environment (name text PRIMARY KEY);
INSERT INTO pwusage_env.environment VALUES ('dev');
SQL
for migration in \
  20260123000001_init_schema.sql \
  20260124152000_feature_changes.sql \
  20261007093013_compact_energy_history.sql \
  20261007094607_compact_energy_day_metadata.sql \
  20261007122207_compact_energy_scalar_reads.sql \
  20261007132054_compact_energy_latest_projection.sql \
  20261007134255_compact_energy_payload_integrity.sql \
  20261007144600_compact_energy_trim_recovery.sql \
  20261007190945_history_archive_job.sql \
  20261024180000_history_archive_all_sites.sql \
  20261024190000_day_record_v2_schema.sql \
  20261025120000_day_record_empty_days.sql \
  20261025131043_day_record_empty_status.sql \
  20261027120000_drop_energy_data.sql \
  20261027180001_drop_legacy_day_record_state.sql; do
  "${egress_psql[@]}" -f "db-migrations/$migration" >"$egress_socket/migration.log" 2>&1 || { cat "$egress_socket/migration.log"; exit 1; }
done
"${egress_psql[@]}" -f scripts/mobile-route-egress-fixture.sql
EGRESS_LOCAL_SOCKET="$egress_socket" MOBILE_MANUAL_IMPORT_NO_COOLDOWN=true npm test -- --run scripts/mobile-route-egress-trace.test.ts --reporter=default --disableConsoleIntercept
