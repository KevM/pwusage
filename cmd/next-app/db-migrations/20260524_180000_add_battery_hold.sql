-- Battery Hold for charging: one active "hold" per site that parks the Powerwall
-- backup reserve at (or above) the current SoC while a large load runs, then
-- auto-restores. See docs/superpowers/specs/2026-05-24-battery-hold-for-charging-design.md
-- Idempotent: IF NOT EXISTS everywhere so CI can re-run safely.
CREATE TABLE IF NOT EXISTS "BatteryHold" (
    id                BIGSERIAL PRIMARY KEY,
    site_id           TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    status            TEXT NOT NULL DEFAULT 'active',
    original_reserve  INTEGER NOT NULL,
    target_reserve    INTEGER NOT NULL,
    parked_soc        NUMERIC NOT NULL,
    baseline_load_w   NUMERIC NOT NULL,
    restore_reason    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_at       TIMESTAMPTZ,
    safety_expires_at TIMESTAMPTZ NOT NULL
);

-- At most one active hold per site.
CREATE UNIQUE INDEX IF NOT EXISTS battery_hold_one_active_per_site
    ON "BatteryHold"(site_id) WHERE status = 'active';

-- Cron access path: scan all active holds cheaply.
CREATE INDEX IF NOT EXISTS battery_hold_active_idx
    ON "BatteryHold"(status) WHERE status = 'active';
