-- Track which followed comparison produced a reference estimate. A null label
-- means the source has no confirmed follow provenance.
ALTER TABLE "TariffUrdbSource"
    ADD COLUMN IF NOT EXISTS followed_reference_label text;
