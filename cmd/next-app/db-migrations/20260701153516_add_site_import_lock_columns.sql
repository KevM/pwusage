-- Migration: add_site_import_lock_columns
-- Created at: 2026-07-01T20:35:16.569Z

ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS import_lock_id TEXT;
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS import_lock_expires BIGINT DEFAULT 0;
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS last_import_at BIGINT DEFAULT 0;
