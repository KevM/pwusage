-- Migration: mobile_login_handoff_session_version
-- Created at: 2026-11-19T01:18:02.096Z

-- Bind each native login handoff to the account's User.session_version when it
-- is created. The exchange consumes a handoff only while that version is still
-- current, so "sign out everywhere" also revokes handoffs still waiting to be
-- exchanged. Nullable so rows written before this deploy stay readable; the
-- exchange treats NULL as unbound and rejects it (fail closed). Those rows
-- expire within five minutes, and the app's next sign-in creates a bound one.
-- No new table, so no RLS change: MobileLoginHandoff keeps its existing policy.
ALTER TABLE "MobileLoginHandoff" ADD COLUMN IF NOT EXISTS session_version INTEGER;
