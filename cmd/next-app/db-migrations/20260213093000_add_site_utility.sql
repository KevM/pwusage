ALTER TABLE "Site"
ADD COLUMN IF NOT EXISTS utility TEXT;

UPDATE "Site"
SET utility = json->'tariff_content_v2'->>'utility'
WHERE utility IS NULL
  AND json IS NOT NULL
  AND json->'tariff_content_v2'->>'utility' IS NOT NULL
  AND json->'tariff_content_v2'->>'utility' <> '';
