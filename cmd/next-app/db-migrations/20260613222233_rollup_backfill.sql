-- Migration: rollup_backfill
-- Per-site ROI history-indexing ledger + forward cursor. Idempotent.
CREATE TABLE IF NOT EXISTS "RollupBackfill" (
    site_id          TEXT PRIMARY KEY REFERENCES "Site"(id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'pending',  -- pending | running | complete | error
    oldest_date      DATE NOT NULL,
    cursor_date      DATE NOT NULL,
    newest_date      DATE NOT NULL,
    days_done        INTEGER NOT NULL DEFAULT 0,
    days_total       INTEGER NOT NULL DEFAULT 0,
    genesis_anchored BOOLEAN NOT NULL DEFAULT false,
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker claim ordering: oldest opt-in first among incomplete rows.
CREATE INDEX IF NOT EXISTS "RollupBackfill_incomplete_idx"
    ON "RollupBackfill" (created_at)
    WHERE status IN ('pending', 'running');
