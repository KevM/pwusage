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

-- Additive only: existing account eligibility is deliberately untouched.
ALTER TABLE "User"
    ADD COLUMN tesla_credential_generation integer NOT NULL DEFAULT 0,
    ADD COLUMN tesla_refresh_attempt_id text,
    ADD COLUMN tesla_refresh_state text NOT NULL DEFAULT 'ready'
        CHECK (tesla_refresh_state IN ('ready', 'in_flight', 'uncertain', 'reconnect_required')),
    ADD COLUMN tesla_refresh_started_at timestamptz,
    ADD COLUMN tesla_refresh_retry_after bigint NOT NULL DEFAULT 0;

-- An old lease already in flight at migration time is not evidence of non-dispatch.
UPDATE "User" SET tesla_refresh_state = CASE
    WHEN auth_status = 'revoked' THEN 'reconnect_required' ELSE 'uncertain' END
WHERE auth_status = 'revoked' OR is_refreshing <> 0;
