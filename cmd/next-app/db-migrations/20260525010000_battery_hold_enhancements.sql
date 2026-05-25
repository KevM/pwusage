-- Battery Hold enhancements: per-hold mode (auto NILM vs strict timer) and a
-- dismissible "reserve changed outside the app" guard notice. status and
-- restore_reason are plain TEXT, so their new values ('cancelled',
-- 'timer_elapsed', 'reserve_changed') need no DDL.
-- See docs/superpowers/specs/2026-05-25-battery-hold-enhancements-design.md
-- Idempotent: ADD COLUMN IF NOT EXISTS so CI can re-run safely.
ALTER TABLE "BatteryHold" ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "BatteryHold" ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
