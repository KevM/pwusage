/** Newest stored sample time for the site `siteRef` (an SQL expression), from its day records; NULL when
 * none exists. One index lookup, never an archive payload. The newest record with samples counts: an
 * `empty` record (Tesla answered the day with none) has no last_timestamp. */
export const latestStoredSampleSql=(siteRef:string)=>`(SELECT last_timestamp FROM "EnergyDayArchive" WHERE site_id=${siteRef} AND status IS DISTINCT FROM 'empty' ORDER BY day_start DESC LIMIT 1)`;
