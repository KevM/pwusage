-- Migration: add_site_live_status_fields
-- Created at: 2026-07-01T21:49:22.792Z

ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS last_live_refresh_at BIGINT DEFAULT 0;
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS live_status_cache JSONB;
