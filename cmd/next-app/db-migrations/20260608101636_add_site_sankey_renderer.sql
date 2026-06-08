-- Per-site Sankey renderer preference (nullable; null treated as 'direct').
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS sankey_renderer TEXT;
