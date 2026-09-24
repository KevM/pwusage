-- Migration: add_mobile_login_handoff
-- Created at: 2026-09-23T23:18:12.663Z

CREATE TABLE IF NOT EXISTS "MobileLoginHandoff" (
  attempt_id UUID PRIMARY KEY,
  code_hash CHAR(64) NOT NULL UNIQUE,
  code_challenge VARCHAR(43) NOT NULL,
  app_state VARCHAR(128) NOT NULL,
  user_id TEXT NOT NULL,
  site_ids TEXT[] NOT NULL,
  roles TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "MobileLoginHandoff_expires_at_idx"
  ON "MobileLoginHandoff" (expires_at);

ALTER TABLE "MobileLoginHandoff" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "MobileLoginHandoff" FROM PUBLIC;
REVOKE ALL ON "MobileLoginHandoff" FROM anon;
REVOKE ALL ON "MobileLoginHandoff" FROM authenticated;
GRANT ALL ON "MobileLoginHandoff" TO service_role;
