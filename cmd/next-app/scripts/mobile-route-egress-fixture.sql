-- Columns needed by the mobile routes beyond the initial and day-record schemas.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS session_version integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS roles text[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS auth_restored_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS fleet_api_base_url text,
    ADD COLUMN IF NOT EXISTS auth_status text DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS tesla_refresh_state text DEFAULT 'ready',
    ADD COLUMN IF NOT EXISTS tesla_refresh_retry_after bigint;
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS utility text,
    ADD COLUMN IF NOT EXISTS timezone_display_mode text,
    ADD COLUMN IF NOT EXISTS sankey_renderer text,
    ADD COLUMN IF NOT EXISTS last_live_refresh_at bigint,
    ADD COLUMN IF NOT EXISTS last_live_claim_at bigint,
    ADD COLUMN IF NOT EXISTS live_status_cache jsonb,
    ADD COLUMN IF NOT EXISTS last_import_at bigint,
    ADD COLUMN IF NOT EXISTS import_lock_expires bigint,
    ADD COLUMN IF NOT EXISTS import_lock_id text;
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS is_current boolean DEFAULT true;

INSERT INTO "User" (id, refresh_token) VALUES ('owner', 'synthetic-token');
INSERT INTO "Site" (id, user_id, name, installed, timezone, json)
    VALUES ('trace', 'owner', 'Synthetic Trace', '2024-01-01', 'UTC', '{"tariff_content_v2":{"currency":"USD"}}');
INSERT INTO "Tariff" (id, site_id, name) VALUES (1, 'trace', 'Utility');
INSERT INTO "TariffSeason" (id, tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
    VALUES (1, 1, 'All year', 1, 1, 12, 31, 0.3, 0.04);
INSERT INTO "TariffSchedule" (id, season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, to_hour, from_minute, to_minute)
    VALUES (1, 1, 'Standard', 0.3, 0.04, 0, 6, 0, 24, 0, 0);
