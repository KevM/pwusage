-- Account history entitlements. No history or tariff deletion occurs here.
-- Existing accounts keep their previous access until notice/grace bootstrap.
ALTER TABLE "User"
    ADD COLUMN history_retention_days INTEGER NOT NULL DEFAULT 90,
    ADD COLUMN history_retention_grace_until TIMESTAMPTZ,
    ADD COLUMN history_retention_transition_pending BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT user_history_retention_days_check CHECK (history_retention_days IN (90, 365));

UPDATE "User" SET history_retention_transition_pending = TRUE;
-- Existing table RLS and grants are unchanged; there are no new tables.
