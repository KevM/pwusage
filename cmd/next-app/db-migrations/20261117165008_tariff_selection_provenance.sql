-- Migration: tariff_selection_provenance
-- Created at: 2026-11-17T21:23:02.749Z

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. Immutable selection records separating source, ownership/protection, and candidate metadata.
CREATE TABLE IF NOT EXISTS "TariffSelection" (
  id                         SERIAL PRIMARY KEY,
  site_id                    TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
  scope                      TEXT NOT NULL CHECK (scope IN ('actual', 'reference')),
  tariff_id                  INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
  effective_from             DATE NOT NULL,
  effective_to               DATE,
  source                     TEXT NOT NULL CHECK (source IN ('tesla', 'manual', 'estimated')),
  choice_kind                TEXT NOT NULL CHECK (choice_kind IN ('automatic', 'owner')),
  candidate_kind             TEXT NOT NULL CHECK (candidate_kind IN ('tesla_sync', 'automatic_estimate', 'manual', 'public', 'restore_tesla')),
  selected_by_user_id        TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  urdb_label                 TEXT,
  utility_name               TEXT,
  revision_start             DATE,
  export_rate_provenance     TEXT NOT NULL DEFAULT 'manual'
                               CHECK (export_rate_provenance IN ('published', 'net_metering', 'inherited', 'manual', 'tesla')),
  holidays_use_weekend       BOOLEAN NOT NULL DEFAULT TRUE,
  approximation_notes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_content_hash      TEXT,
  restored_from_selection_id INTEGER REFERENCES "TariffSelection"(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS tariff_selection_site_scope_idx
  ON "TariffSelection" (site_id, scope, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tariff_selection_tariff_idx
  ON "TariffSelection" (tariff_id);

ALTER TABLE "TariffSelection" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TariffSelection" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "TariffSelection" TO service_role;
GRANT ALL ON SEQUENCE "TariffSelection_id_seq" TO service_role;

-- 2. Saved original Tesla tariff versions per replaced interval so restoration stays exact even
--    when a Tesla version no longer owns any effective row or later Tesla imports arrive.
CREATE TABLE IF NOT EXISTS "TariffSelectionOriginal" (
  id                    SERIAL PRIMARY KEY,
  selection_id          INTEGER NOT NULL REFERENCES "TariffSelection"(id) ON DELETE CASCADE,
  site_id               TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
  scope                 TEXT NOT NULL CHECK (scope IN ('actual', 'reference')),
  effective_from        DATE NOT NULL,
  effective_to          DATE,
  original_tariff_id    INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
  original_selection_id INTEGER REFERENCES "TariffSelection"(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS tariff_selection_original_selection_idx
  ON "TariffSelectionOriginal" (selection_id, effective_from);
CREATE INDEX IF NOT EXISTS tariff_selection_original_site_scope_dates_idx
  ON "TariffSelectionOriginal" (site_id, scope, effective_from, effective_to);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_selection_original_no_overlap') THEN
    ALTER TABLE "TariffSelectionOriginal"
      ADD CONSTRAINT tariff_selection_original_no_overlap
      EXCLUDE USING gist (
        selection_id WITH =,
        daterange(effective_from, COALESCE((effective_to + INTERVAL '1 day')::date, 'infinity'::date), '[)') WITH &&
      );
  END IF;
END $$;

ALTER TABLE "TariffSelectionOriginal" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TariffSelectionOriginal" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "TariffSelectionOriginal" TO service_role;
GRANT ALL ON SEQUENCE "TariffSelectionOriginal_id_seq" TO service_role;

-- 3. Verification records bound strictly to selection, tariff version, content hash, exact range, verifier, and timestamp.
CREATE TABLE IF NOT EXISTS "TariffSelectionVerification" (
  id                   SERIAL PRIMARY KEY,
  selection_id         INTEGER NOT NULL UNIQUE REFERENCES "TariffSelection"(id) ON DELETE CASCADE,
  site_id              TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
  scope                TEXT NOT NULL CHECK (scope IN ('actual', 'reference')),
  tariff_id            INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
  tariff_content_hash  TEXT NOT NULL,
  effective_from       DATE NOT NULL,
  effective_to         DATE,
  verified_by_user_id  TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  verified_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS tariff_selection_verification_site_idx
  ON "TariffSelectionVerification" (site_id, scope, verified_at DESC);
CREATE INDEX IF NOT EXISTS tariff_selection_verification_tariff_idx
  ON "TariffSelectionVerification" (tariff_id);

ALTER TABLE "TariffSelectionVerification" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TariffSelectionVerification" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "TariffSelectionVerification" TO service_role;
GRANT ALL ON SEQUENCE "TariffSelectionVerification_id_seq" TO service_role;

-- 4. Link effective and reference periods to their selection provenance record.
ALTER TABLE "TariffEffectivePeriod"
  ADD COLUMN IF NOT EXISTS selection_id INTEGER REFERENCES "TariffSelection"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS tariff_effective_period_selection_idx
  ON "TariffEffectivePeriod" (selection_id);

ALTER TABLE "TariffReferencePeriod"
  ADD COLUMN IF NOT EXISTS selection_id INTEGER REFERENCES "TariffSelection"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS tariff_reference_period_selection_idx
  ON "TariffReferencePeriod" (selection_id);

-- 5. Protect public source records from estimate-job blanket deletion while distinguishing
--    active desired automatic estimates from preserved/owner-selected public tariffs.
ALTER TABLE "TariffUrdbSource"
  ADD COLUMN IF NOT EXISTS is_current_estimate BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "TariffUrdbSource" DROP CONSTRAINT IF EXISTS "TariffUrdbSource_role_check";
ALTER TABLE "TariffUrdbSource" ADD CONSTRAINT "TariffUrdbSource_role_check"
  CHECK (role IN ('tesla_anchor', 'estimated_actual', 'estimated_reference', 'owner_history', 'owner_selection'));

UPDATE "TariffUrdbSource"
SET is_current_estimate = FALSE
WHERE role IN ('owner_history', 'owner_selection')
  AND is_current_estimate = TRUE;

-- 6. Idempotent backfill: existing explicit owner periods become protected/unverified;
--    existing Tesla periods get automatic (or owner if updated_by_user_id is set) selection records.
--    Automatic estimated gap rows stay selection_id = NULL until explicitly selected.
DO $$
DECLARE
  rec RECORD;
  new_selection_id INTEGER;
BEGIN
  FOR rec IN
    SELECT
      p.id AS period_id,
      p.site_id,
      p.tariff_id,
      p.effective_from,
      p.effective_to,
      p.source,
      CASE
        WHEN p.source = 'manual' OR p.updated_by_user_id IS NOT NULL THEN 'owner'
        ELSE 'automatic'
      END AS choice_kind,
      CASE
        WHEN p.source = 'manual' THEN 'manual'
        WHEN p.source = 'estimated' THEN 'public'
        ELSE 'tesla_sync'
      END AS candidate_kind,
      p.updated_by_user_id AS selected_by_user_id,
      us.urdb_label,
      CASE
        WHEN p.source = 'estimated' OR us.tariff_id IS NOT NULL THEN su.urdb_utility
        ELSE NULL
      END AS utility_name,
      us.revision_start,
      CASE
        WHEN p.source = 'tesla' THEN 'tesla'
        WHEN p.source = 'estimated' THEN 'published'
        ELSE 'manual'
      END AS export_rate_provenance,
      t.content_hash AS selected_content_hash,
      p.created_at
    FROM "TariffEffectivePeriod" p
    JOIN "Tariff" t ON t.id = p.tariff_id
    LEFT JOIN "TariffUrdbSource" us ON us.tariff_id = p.tariff_id
    LEFT JOIN "SiteUtility" su ON su.site_id = p.site_id
    WHERE p.selection_id IS NULL
      AND (p.source <> 'estimated' OR p.updated_by_user_id IS NOT NULL)
    ORDER BY p.id ASC
  LOOP
    INSERT INTO "TariffSelection" (
      site_id, scope, tariff_id, effective_from, effective_to,
      source, choice_kind, candidate_kind, selected_by_user_id,
      urdb_label, utility_name, revision_start, export_rate_provenance,
      holidays_use_weekend, approximation_notes, selected_content_hash, created_at
    ) VALUES (
      rec.site_id, 'actual', rec.tariff_id, rec.effective_from, rec.effective_to,
      rec.source, rec.choice_kind, rec.candidate_kind, rec.selected_by_user_id,
      rec.urdb_label, rec.utility_name, rec.revision_start, rec.export_rate_provenance,
      TRUE, '[]'::jsonb, rec.selected_content_hash, rec.created_at
    )
    RETURNING id INTO new_selection_id;

    UPDATE "TariffEffectivePeriod"
    SET selection_id = new_selection_id
    WHERE id = rec.period_id;
  END LOOP;

  FOR rec IN
    SELECT
      p.id AS period_id,
      p.site_id,
      p.tariff_id,
      p.effective_from,
      p.effective_to,
      p.source,
      CASE WHEN p.source = 'estimated' THEN 'public' ELSE 'manual' END AS candidate_kind,
      p.updated_by_user_id AS selected_by_user_id,
      us.urdb_label,
      CASE
        WHEN p.source = 'estimated' OR us.tariff_id IS NOT NULL THEN su.urdb_utility
        ELSE NULL
      END AS utility_name,
      us.revision_start,
      CASE WHEN p.source = 'estimated' THEN 'published' ELSE 'manual' END AS export_rate_provenance,
      t.content_hash AS selected_content_hash,
      p.created_at
    FROM "TariffReferencePeriod" p
    JOIN "Tariff" t ON t.id = p.tariff_id
    LEFT JOIN "TariffUrdbSource" us ON us.tariff_id = p.tariff_id
    LEFT JOIN "SiteUtility" su ON su.site_id = p.site_id
    WHERE p.selection_id IS NULL
      AND (p.source <> 'estimated' OR p.updated_by_user_id IS NOT NULL)
    ORDER BY p.id ASC
  LOOP
    INSERT INTO "TariffSelection" (
      site_id, scope, tariff_id, effective_from, effective_to,
      source, choice_kind, candidate_kind, selected_by_user_id,
      urdb_label, utility_name, revision_start, export_rate_provenance,
      holidays_use_weekend, approximation_notes, selected_content_hash, created_at
    ) VALUES (
      rec.site_id, 'reference', rec.tariff_id, rec.effective_from, rec.effective_to,
      rec.source, 'owner', rec.candidate_kind, rec.selected_by_user_id,
      rec.urdb_label, rec.utility_name, rec.revision_start, rec.export_rate_provenance,
      TRUE, '[]'::jsonb, rec.selected_content_hash, rec.created_at
    )
    RETURNING id INTO new_selection_id;

    UPDATE "TariffReferencePeriod"
    SET selection_id = new_selection_id
    WHERE id = rec.period_id;
  END LOOP;
END $$;
