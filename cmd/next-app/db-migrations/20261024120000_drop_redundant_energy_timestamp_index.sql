-- Drop idx_energy_timestamp (EnergyData(timestamp)), added in
-- 20260522_192520_add_fk_indexes.sql to narrow the daily retention delete.
--
-- It is redundant: energy_ts_site_uidx is UNIQUE(timestamp, site_id), which
-- leads with timestamp and serves `DELETE ... WHERE timestamp < $1` and every
-- other timestamp-range scan. Prod and Dev share a 500 MB Supabase quota, and
-- this index was 18 MB on Prod.
--
-- Already dropped out-of-band on Prod and Dev on 2026-10-24 with
-- DROP INDEX CONCURRENTLY (alongside REINDEX CONCURRENTLY of idx_energy_site_ts
-- and energy_ts_site_uidx, which had bloated from out-of-order backfill
-- inserts: 97 MB and 81 MB -> 55 MB each). This file keeps fresh databases in
-- step; on Prod and Dev it is a no-op. Plain DROP INDEX because
-- `supabase migration up` wraps each file in a transaction.

DROP INDEX IF EXISTS idx_energy_timestamp;
