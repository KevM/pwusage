-- Migration: urdb_owner_history
-- Created at: 2026-11-16T19:00:00.000Z

-- No new table: RLS and grants on "TariffUrdbSource" were set when it was created.
-- Owner history rows mark manual plans the owner chose from public utility rates
-- (the rate plan history guide). The estimate job only touches its own roles.
ALTER TABLE "TariffUrdbSource" DROP CONSTRAINT IF EXISTS "TariffUrdbSource_role_check";
ALTER TABLE "TariffUrdbSource" ADD CONSTRAINT "TariffUrdbSource_role_check"
  CHECK (role IN ('tesla_anchor', 'estimated_actual', 'estimated_reference', 'owner_history'));
