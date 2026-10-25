-- Migration: user_fleet_api_base_url
-- Created at: 2026-10-25T19:00:00.000Z

-- Each Tesla account is served from one regional Fleet API host; the wrong one
-- answers 421 "user out of region". Store the account's host (resolved at login
-- via GET /api/1/users/region, or learned from a 421). NULL = unknown, which the
-- app treats as North America. The app only writes allowlisted Tesla hosts
-- (src/lib/tesla-region.ts); the CHECK keeps the stored value an https Tesla
-- origin even if a writer bypasses that. Idempotent.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS fleet_api_base_url TEXT;

ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_fleet_api_base_url_check";
ALTER TABLE "User" ADD CONSTRAINT "User_fleet_api_base_url_check" CHECK (
    fleet_api_base_url IS NULL
    OR fleet_api_base_url IN (
        'https://fleet-api.prd.na.vn.cloud.tesla.com',
        'https://fleet-api.prd.eu.vn.cloud.tesla.com',
        'https://fleet-api.prd.cn.vn.cloud.tesla.cn'
    )
);
