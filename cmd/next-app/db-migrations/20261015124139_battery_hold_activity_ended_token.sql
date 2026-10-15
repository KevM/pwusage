-- Migration: battery_hold_activity_ended_token
-- Created at: 2026-10-15T17:41:39.719Z

-- An ended Live Activity receives no further pushes, so the delivery worker
-- clears its token on the accepted end; only pending/current rows need one.
ALTER TABLE "BatteryHoldActivity" DROP CONSTRAINT IF EXISTS battery_hold_activity_token;
ALTER TABLE "BatteryHoldActivity" ADD CONSTRAINT battery_hold_activity_token
    CHECK (delivery_state IN ('ended', 'disabled') OR push_token IS NOT NULL);
