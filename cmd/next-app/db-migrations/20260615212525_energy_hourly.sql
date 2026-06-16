-- Plan-agnostic hourly energy profile: 24 buckets/day of per-flow energies (Wh),
-- re-bucketable into any tariff's TOU windows for the savings comparison matrix.
-- No rates, no provenance — those are computed on read (Phase C).
CREATE TABLE IF NOT EXISTS "EnergyHourly" (
    site_id              text     NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    local_date           date     NOT NULL,
    hour                 smallint NOT NULL,
    load_wh              double precision NOT NULL DEFAULT 0,
    solar_to_home_wh     double precision NOT NULL DEFAULT 0,
    solar_to_battery_wh  double precision NOT NULL DEFAULT 0,
    solar_to_grid_wh     double precision NOT NULL DEFAULT 0,
    grid_to_home_wh      double precision NOT NULL DEFAULT 0,
    grid_to_battery_wh   double precision NOT NULL DEFAULT 0,
    battery_to_home_wh   double precision NOT NULL DEFAULT 0,
    battery_to_grid_wh   double precision NOT NULL DEFAULT 0,
    solar_only_import_wh double precision NOT NULL DEFAULT 0,
    solar_only_export_wh double precision NOT NULL DEFAULT 0,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, local_date, hour)
);

ALTER TABLE "EnergyHourly" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "EnergyHourly" FROM PUBLIC;
REVOKE ALL ON "EnergyHourly" FROM anon;
REVOKE ALL ON "EnergyHourly" FROM authenticated;
GRANT ALL ON "EnergyHourly" TO service_role;
