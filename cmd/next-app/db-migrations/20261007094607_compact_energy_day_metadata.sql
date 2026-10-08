-- Existing revisions retain the detailed decode path until finalization rebuilds
-- them. No raw rows or payloads are touched by this additive migration.
ALTER TABLE "EnergyDayArchive"
    ADD COLUMN first_timestamp timestamptz,
    ADD COLUMN last_timestamp timestamptz,
    ADD COLUMN max_interior_gap_ms integer,
    ADD COLUMN metadata_checksum text,
    ADD CONSTRAINT "EnergyDayArchive_metadata_check" CHECK (
        (metadata_checksum IS NULL AND first_timestamp IS NULL AND last_timestamp IS NULL AND max_interior_gap_ms IS NULL)
        OR (metadata_checksum IS NOT NULL AND metadata_checksum ~ '^[0-9a-f]{64}$'
            AND first_timestamp IS NOT NULL AND last_timestamp IS NOT NULL AND max_interior_gap_ms IS NOT NULL
            AND first_timestamp >= day_start AND last_timestamp < day_end AND first_timestamp <= last_timestamp
            AND max_interior_gap_ms >= 0 AND max_interior_gap_ms <= EXTRACT(EPOCH FROM day_end-day_start)*1000)
    );
