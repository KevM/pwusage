/** Newest stored sample time for the site `siteRef` (an SQL expression), from raw rows or day records,
 * whichever is later; NULL when neither exists. Two index lookups, never an archive payload. The newest
 * record with samples counts: an `empty` record (Tesla answered the day with none) has no last_timestamp. */
export const latestStoredSampleSql=(siteRef:string)=>`GREATEST(
    (SELECT max(timestamp) FROM "EnergyData" WHERE site_id=${siteRef}),
    (SELECT last_timestamp FROM "EnergyDayArchive" WHERE site_id=${siteRef} AND status IS DISTINCT FROM 'empty' ORDER BY day_start DESC LIMIT 1))`;
