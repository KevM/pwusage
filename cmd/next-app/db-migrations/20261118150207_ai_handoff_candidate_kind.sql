-- Migration: ai_handoff_candidate_kind
-- Created at: 2026-11-18T21:02:07.207Z

ALTER TABLE "TariffSelection"
  DROP CONSTRAINT IF EXISTS "TariffSelection_candidate_kind_check";

ALTER TABLE "TariffSelection"
  ADD CONSTRAINT "TariffSelection_candidate_kind_check"
  CHECK (candidate_kind IN ('tesla_sync', 'automatic_estimate', 'manual', 'public', 'restore_tesla', 'ai_handoff'));
