/**
 * SQL expression for the id of the tariff in effect today for a site, in the site's timezone.
 * Same policy as resolveTariffForDate, so a date rollover takes effect without a mutation:
 * the plan covering today, else (in a gap) the nearest earlier plan, else the earliest, else
 * the stored `is_current` flag. `siteIdRef` is the SQL reference to the site id (e.g. `s.id`).
 */
export function effectiveTariffIdSql(siteIdRef: string): string {
  return `COALESCE(
    (SELECT p.tariff_id FROM "TariffEffectivePeriod" p
        JOIN "Site" st ON st.id = p.site_id
        WHERE p.site_id = ${siteIdRef}
          AND p.effective_from <= (now() AT TIME ZONE st.timezone)::date
          AND (p.effective_to IS NULL OR p.effective_to >= (now() AT TIME ZONE st.timezone)::date)
        ORDER BY p.effective_from DESC LIMIT 1),
    (SELECT p.tariff_id FROM "TariffEffectivePeriod" p
        JOIN "Site" st ON st.id = p.site_id
        WHERE p.site_id = ${siteIdRef} AND p.effective_to IS NOT NULL
          AND p.effective_to < (now() AT TIME ZONE st.timezone)::date
        ORDER BY p.effective_to DESC LIMIT 1),
    (SELECT p.tariff_id FROM "TariffEffectivePeriod" p
        WHERE p.site_id = ${siteIdRef} ORDER BY p.effective_from ASC LIMIT 1),
    (SELECT t2.id FROM "Tariff" t2 WHERE t2.site_id = ${siteIdRef} AND t2.is_current LIMIT 1))`;
}
