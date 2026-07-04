-- Migration: add_site_live_claim_at
-- Created at: 2026-07-03T19:59:00.901Z

ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS last_live_claim_at BIGINT DEFAULT 0;
