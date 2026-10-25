/**
 * Insert or refresh a site from Tesla's site info ($1 id, $2 name, $3 utility,
 * $4 installed, $5 timezone, $6 json, $7 whether $4 came from Tesla); returns
 * the stored timezone. A timezone change re-keys every local day, so it is
 * kept back while any day is pruned (its record is then the only copy, and the
 * `invalidate_compact_energy_timezone` trigger would refuse the change):
 * scripts/rebuild-site-timezone.ts re-keys the stored days and changes it in
 * one transaction. Tesla's value stays visible in `json`.
 */
export const UPSERT_SITE_SQL = `
    INSERT INTO "Site"(id, name, utility, updated, installed, timezone, json)
    VALUES ($1, $2, $3, NOW(), $4, $5, $6)
    ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN EXCLUDED.name = 'Unnamed Site' AND "Site".name IS NOT NULL AND "Site".name != '' THEN "Site".name ELSE EXCLUDED.name END,
        utility = EXCLUDED.utility,
        installed = CASE WHEN $7 = false AND "Site".installed IS NOT NULL THEN "Site".installed ELSE EXCLUDED.installed END,
        timezone = CASE WHEN EXCLUDED.timezone = 'UTC' AND "Site".timezone IS NOT NULL AND "Site".timezone != '' THEN "Site".timezone
            WHEN EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id = "Site".id AND a.raw_pruned) THEN "Site".timezone
            ELSE EXCLUDED.timezone END,
        json = EXCLUDED.json
    RETURNING timezone`;
