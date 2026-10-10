-- Daily history archival starts paused; production activation is separate.
CREATE TABLE "HistoryArchiveControl" (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    paused boolean NOT NULL DEFAULT true,
    trim boolean NOT NULL DEFAULT false,
    site_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(site_ids)<=100),
    from_date date,
    before_date date,
    CHECK ((from_date IS NULL AND before_date IS NULL) OR (from_date IS NOT NULL AND before_date IS NOT NULL AND before_date>from_date)),
    last_run_at timestamptz,
    last_report jsonb
);
INSERT INTO "HistoryArchiveControl" (id) VALUES (true);
CREATE TABLE "HistoryArchiveRetry" (
    site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    day_start timestamptz NOT NULL,
    day_end timestamptz NOT NULL CHECK (day_end > day_start),
    attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 30),
    retry_after timestamptz NOT NULL,
    reason text NOT NULL CHECK (reason IN ('busy','failed','incomplete-attribution','source-too-large')),
    PRIMARY KEY (site_id,day_start)
);
ALTER TABLE "HistoryArchiveControl" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "HistoryArchiveControl" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "HistoryArchiveControl" TO service_role;
ALTER TABLE "HistoryArchiveRetry" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "HistoryArchiveRetry" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "HistoryArchiveRetry" TO service_role;
