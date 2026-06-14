-- ROI comparison plans: tariffs can be reporting-only (priced read-side, never
-- metered) and carry an effective_from date (captured for display/ordering this
-- phase; date-resolved pricing is deferred — see F1/F2 in TODO.md).
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS reporting_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS effective_from DATE NULL;

-- Friendly label for the metered base plan, only where it has none. Never
-- clobbers a real imported utility name. Touches only blank/whitespace names.
UPDATE "Tariff" SET name = 'Standard'
 WHERE reporting_only = false
   AND (name IS NULL OR btrim(name) = '');
