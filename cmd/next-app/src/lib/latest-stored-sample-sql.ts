/** Newest stored sample time for the site `siteRef` (an SQL expression), from raw rows or day records,
 * whichever is later; NULL when neither exists. Two index lookups, never an archive payload. */
export const latestStoredSampleSql=(siteRef:string)=>`GREATEST(
    (SELECT max(timestamp) FROM "EnergyData" WHERE site_id=${siteRef}),
    (SELECT last_timestamp FROM "EnergyDayArchive" WHERE site_id=${siteRef} ORDER BY day_start DESC LIMIT 1))`;
