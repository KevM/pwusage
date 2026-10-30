-- Migration: tesla_refresh_outcomes
-- Created at: 2026-10-29T00:25:59.789Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- Idempotent: CI re-runs migrations against fresh prod copies.
ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS tesla_credential_generation integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tesla_refresh_attempt_id text,
    ADD COLUMN IF NOT EXISTS tesla_refresh_state text NOT NULL DEFAULT 'ready'
        CHECK (tesla_refresh_state IN ('ready', 'in_flight', 'uncertain', 'reconnect_required')),
    ADD COLUMN IF NOT EXISTS tesla_refresh_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS tesla_refresh_retry_after bigint NOT NULL DEFAULT 0;

-- A rejected refresh grant needs a Tesla reconnect. The old revocation path was
-- the only writer of is_active = false, and OAuth login no longer resets it, so
-- clear it here or those users could never reconnect.
UPDATE "User" SET tesla_refresh_state = 'reconnect_required', is_active = true
WHERE auth_status = 'revoked' AND tesla_refresh_state = 'ready';
UPDATE "User" SET is_active = true WHERE is_active IS DISTINCT FROM true;
