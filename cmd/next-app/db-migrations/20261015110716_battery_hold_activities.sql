-- Migration: battery_hold_activities
-- Created at: 2026-10-15T16:07:16.234Z

-- One row per registered Live Activity. BatteryHold stays authoritative; this
-- table only stores the delivery address and desired/delivered push versions.
CREATE TABLE IF NOT EXISTS "BatteryHoldActivity" (
    id                BIGSERIAL PRIMARY KEY,
    hold_id           BIGINT NOT NULL REFERENCES "BatteryHold"(id) ON DELETE CASCADE,
    user_id           TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    registration_id   UUID NOT NULL,
    push_token        TEXT,
    apns_environment  TEXT NOT NULL CHECK (apns_environment IN ('sandbox', 'production')),
    delivery_state    TEXT NOT NULL DEFAULT 'pending'
                      CHECK (delivery_state IN ('pending', 'current', 'ended', 'disabled')),
    desired_version   INTEGER NOT NULL DEFAULT 0,
    desired_snapshot  JSONB,
    delivered_version INTEGER NOT NULL DEFAULT 0,
    claim_owner       UUID,
    claim_expires_at  TIMESTAMPTZ,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    next_attempt_at   TIMESTAMPTZ,
    last_error        TEXT,
    disabled_reason   TEXT,
    expires_at        TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT battery_hold_activity_registration UNIQUE (user_id, registration_id),
    CONSTRAINT battery_hold_activity_versions CHECK (delivered_version <= desired_version),
    CONSTRAINT battery_hold_activity_token CHECK (delivery_state = 'disabled' OR push_token IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS battery_hold_activity_hold_idx ON "BatteryHoldActivity"(hold_id);
-- Delivery worker access path (later task): pending rows ordered by retry time.
CREATE INDEX IF NOT EXISTS battery_hold_activity_pending_idx
    ON "BatteryHoldActivity"(next_attempt_at) WHERE delivery_state = 'pending';

ALTER TABLE "BatteryHoldActivity" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "BatteryHoldActivity" FROM PUBLIC;
REVOKE ALL ON "BatteryHoldActivity" FROM anon;
REVOKE ALL ON "BatteryHoldActivity" FROM authenticated;
GRANT ALL ON "BatteryHoldActivity" TO service_role;
GRANT ALL ON SEQUENCE "BatteryHoldActivity_id_seq" TO service_role;
