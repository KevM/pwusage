-- Migration: tesla_tariff_sync_attempt
-- Created at: 2026-11-19T17:49:45.000Z

-- One row per "Sync to Tesla" write. The partial unique index allows at most one in-flight
-- ('sending') attempt per site, so a double press or a second device cannot start a second write.
CREATE TABLE IF NOT EXISTS "TeslaTariffSyncAttempt" (
    id BIGSERIAL PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    selection_id BIGINT,
    replaced_tesla_tariff_id BIGINT,
    sent_content JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sending', 'confirmed', 'unconfirmed', 'rejected', 'failed', 'not_allowed')),
    tesla_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tesla_tariff_sync_attempt_site_created_idx
    ON "TeslaTariffSyncAttempt"(site_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS tesla_tariff_sync_attempt_one_sending_uidx
    ON "TeslaTariffSyncAttempt"(site_id) WHERE status = 'sending';

ALTER TABLE "TeslaTariffSyncAttempt" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TeslaTariffSyncAttempt" FROM PUBLIC;
REVOKE ALL ON "TeslaTariffSyncAttempt" FROM anon;
REVOKE ALL ON "TeslaTariffSyncAttempt" FROM authenticated;
GRANT ALL ON "TeslaTariffSyncAttempt" TO service_role;
GRANT ALL ON SEQUENCE "TeslaTariffSyncAttempt_id_seq" TO service_role;
