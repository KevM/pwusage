-- Rollback-only dev fixture captured from the actual generated writer SQL on 2026-10-01.
-- Uses session-local shadow tables; it never changes public data. All assertions must pass.
-- Re-capture after writer SQL changes. This checks filtering, not public schema FK integration.
BEGIN;
CREATE TEMP TABLE "User" (id text primary key, history_retention_days integer not null, history_retention_grace_until timestamptz, history_retention_transition_pending boolean not null) ON COMMIT DROP;
CREATE TEMP TABLE "Site" (id text primary key, user_id text, timezone text) ON COMMIT DROP;
CREATE TEMP TABLE "EnergyData" (site_id text, tariff_id bigint, timestamp timestamptz, load_power double precision, solar_power double precision, grid_power double precision, battery_power double precision, battery_soc double precision, tariff_schedule_id bigint, UNIQUE(timestamp,site_id)) ON COMMIT DROP;
INSERT INTO "User" VALUES ('u90',90,NULL,FALSE),('u365',365,NULL,FALSE),('upending',90,NULL,TRUE),('ugrace',90,statement_timestamp()+interval '1 hour',FALSE),('uexpired',90,statement_timestamp()-interval '1 hour',FALSE);
INSERT INTO "Site" VALUES ('s90','u90','America/Chicago'),('s365','u365','America/Chicago'),('spending','upending','America/Chicago'),('sgrace','ugrace','America/Chicago'),('sexpired','uexpired','America/Chicago'),('sunowned',NULL,'America/Chicago');

            WITH history_policies AS MATERIALIZED (
                SELECT s.id,
                    (date_trunc('day', statement_timestamp() AT TIME ZONE COALESCE(NULLIF(s.timezone, ''), 'UTC'))
                        - make_interval(days => CASE
                            WHEN u.history_retention_days = 365 OR u.history_retention_transition_pending
                                OR u.history_retention_grace_until > statement_timestamp() THEN 365
                            ELSE 90 END)) AT TIME ZONE COALESCE(NULLIF(s.timezone, ''), 'UTC') AS cutoff
                FROM "Site" s JOIN "User" u ON u.id = s.user_id
                WHERE s.id = ANY(ARRAY['s90','s365','spending','sgrace','sexpired','sunowned']::text[]) AND u.history_retention_days IN (90, 365)
            ), incoming(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, tariff_schedule_id) AS (
                VALUES ('s90'::text, 1::bigint, (((date_trunc('day', statement_timestamp() AT TIME ZONE 'America/Chicago') - interval '90 days') AT TIME ZONE 'America/Chicago') - interval '1 millisecond')::timestamptz, 1::double precision, 0::double precision, 1::double precision, 0::double precision, NULL::double precision, NULL::bigint), ('s90'::text, 1::bigint, ((date_trunc('day', statement_timestamp() AT TIME ZONE 'America/Chicago') - interval '90 days') AT TIME ZONE 'America/Chicago')::timestamptz, 1::double precision, 0::double precision, 1::double precision, 0::double precision, NULL::double precision, NULL::bigint), ('s90'::text, 1::bigint, (((date_trunc('day', statement_timestamp() AT TIME ZONE 'America/Chicago') - interval '90 days') AT TIME ZONE 'America/Chicago') + interval '5 minutes')::timestamptz, 1::double precision, 0::double precision, 1::double precision, 0::double precision, NULL::double precision, NULL::bigint), ('s365'::text, 1::bigint, ((date_trunc('day', statement_timestamp() AT TIME ZONE 'America/Chicago') - interval '200 days') AT TIME ZONE 'America/Chicago')::timestamptz, 1::double precision, 0::double precision, 1::double precision, 0::double precision, NULL::double precision, NULL::bigint), ('spending'::text, 1::bigint, ((date_trunc('day', statement_timestamp() AT TIME ZONE 'America/Chicago') - interval '200 days') AT TIME ZONE 'America/Chicago')::timestamptz, 1::double precision, 0::double precision, 1::double precision, 0::double precision, NULL::double precision, NULL::bigint), ('sgrace'::text, 1::bigint, ((date_trunc('day', statement_timestamp() AT TIME ZONE 'America/Chicago') - interval '200 days') AT TIME ZONE 'America/Chicago')::timestamptz, 1::double precision, 0::double precision, 1::double precision, 0::double precision, NULL::double precision, NULL::bigint), ('sexpired'::text, 1::bigint, ((date_trunc('day', statement_timestamp() AT TIME ZONE 'America/Chicago') - interval '200 days') AT TIME ZONE 'America/Chicago')::timestamptz, 1::double precision, 0::double precision, 1::double precision, 0::double precision, NULL::double precision, NULL::bigint), ('sunowned'::text, 1::bigint, statement_timestamp()::timestamptz, 1::double precision, 0::double precision, 1::double precision, 0::double precision, NULL::double precision, NULL::bigint)
            )
            INSERT INTO "EnergyData"(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, tariff_schedule_id)
            SELECT incoming.* FROM incoming JOIN history_policies policy ON policy.id = incoming.site_id
            WHERE incoming.timestamp >= policy.cutoff
            ON CONFLICT(timestamp, site_id) DO UPDATE SET
                tariff_id = EXCLUDED.tariff_id,
                load_power = EXCLUDED.load_power,
                solar_power = EXCLUDED.solar_power,
                grid_power = EXCLUDED.grid_power,
                battery_power = EXCLUDED.battery_power,
                battery_soc = COALESCE(EXCLUDED.battery_soc, "EnergyData".battery_soc),
                tariff_schedule_id = EXCLUDED.tariff_schedule_id
        ;
DO $verify$
BEGIN
 IF (SELECT count(*) FROM "EnergyData") <> 5 THEN RAISE EXCEPTION 'Expected five retained fixture rows'; END IF;
 IF EXISTS (SELECT 1 FROM "EnergyData" WHERE site_id IN ('sexpired','sunowned')) THEN RAISE EXCEPTION 'Expired grace or unowned rows accepted'; END IF;
 IF (SELECT count(*) FROM "EnergyData" WHERE site_id='s90') <> 2 THEN RAISE EXCEPTION 'Exact cutoff filtering failed'; END IF;
END $verify$;
ROLLBACK;
SELECT true AS actual_writer_fixture_passed;
