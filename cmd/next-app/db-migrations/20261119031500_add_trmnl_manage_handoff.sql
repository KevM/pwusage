-- Migration: add_trmnl_manage_handoff
-- Created at: 2026-11-19T01:10:31.723Z

CREATE TABLE IF NOT EXISTS "TrmnlManageHandoff" (
  id UUID PRIMARY KEY,
  device_uuid TEXT NOT NULL,
  browser_binding_hash CHAR(64) NOT NULL,
  trmnl_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "TrmnlManageHandoff_expires_at_idx"
  ON "TrmnlManageHandoff" (expires_at);

ALTER TABLE "TrmnlManageHandoff" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TrmnlManageHandoff" FROM PUBLIC;
REVOKE ALL ON "TrmnlManageHandoff" FROM anon;
REVOKE ALL ON "TrmnlManageHandoff" FROM authenticated;
GRANT ALL ON "TrmnlManageHandoff" TO service_role;
