-- Backfill user emails from Trmnl installation JSON data
-- This migration extracts email addresses from TrmnlInstallation.json and updates User records

UPDATE "User" u
SET email = ti.json->>'email'
FROM "TrmnlInstallation" ti
JOIN "Site" s ON s.id = ti.site_id
WHERE s.user_id = u.id
  AND ti.json IS NOT NULL
  AND ti.json->>'email' IS NOT NULL
  AND ti.json->>'email' != ''
  AND (u.email IS NULL OR u.email = '');
