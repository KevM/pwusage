-- Migration: add_session_version_to_user
-- Created at: 2026-10-23T22:43:18.520Z
--
-- Adds a monotonically increasing session_version used to revoke all
-- outstanding site_auth JWTs at once ("sign out everywhere"). Tokens embed
-- the version as the `sv` claim; a token whose sv is behind the DB value is
-- rejected on every authenticated request and refused refresh.
-- The "User" table already has RLS from init; no new-table RLS needed here.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_user_session_version ON "User"(id, session_version);
