-- Migration: user_refresh_token_fp
-- Created at: 2026-11-09T13:22:13.756Z

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;

-- HMAC-SHA256 fingerprint of the stored Tesla refresh token. Tokens are encrypted
-- with a random IV, so the single-use refresh compare-and-swap compares this column
-- instead of the ciphertext. NULL until the row is written or backfilled
-- (scripts/encrypt-tesla-tokens.ts). Existing table: no RLS changes needed.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS refresh_token_fp TEXT;
