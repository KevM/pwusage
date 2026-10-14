import 'dotenv/config';
import {deepStrictEqual} from 'node:assert';
import {pool} from '../src/lib/db';
import {HistoryArchiveRepo} from '../src/lib/history-archive-repo';
import {runHistoryArchive} from '../src/lib/history-archive-service';
import {CompactHistoryStore} from '../src/lib/prototypes/compact-history-store';
import {CompactHistoryReader} from '../src/lib/prototypes/compact-history-reader';
import {validateMaintenanceDates} from '../src/lib/prototypes/compact-history-maintenance';
import {addDaysInSiteTimezone,parseSiteLocalDateToMidnight} from '../src/lib/date-utils';

/** One-day hosted Dev rehearsal. Refuses production and restores the original samples. */
async function run():Promise<void> {
    const [siteId,from,before,...extra]=process.argv.slice(2);
    if(!siteId||!from||!before||extra.length)throw new Error('Expected SITE_ID FROM BEFORE local dates');
    validateMaintenanceDates(from,before);
    const url=new URL(process.env.DATABASE_URL??'');
    const devRef='aipxozppjmijrpwyuvuo';
    if(!url.hostname.includes(devRef)&&!url.username.endsWith(`.${devRef}`))throw new Error('Rehearsal requires the verified PWUsage Dev database');
    const initial=(await pool.query<{paused:boolean;trim:boolean;site_ids:string[];from_date:string|null;before_date:string|null}>(
        'SELECT paused,trim,site_ids,from_date::text,before_date::text FROM "HistoryArchiveControl" WHERE id=true')).rows[0];
    if(!initial?.paused)throw new Error('Pause the Dev job before rehearsing');
    const site=(await pool.query<{timezone:string}>('SELECT timezone FROM "Site" WHERE id=$1 AND user_id IS NOT NULL',[siteId])).rows[0];
    if(!site)throw new Error('Owned Dev site required');
    const start=parseSiteLocalDateToMidnight(from,site.timezone);const end=parseSiteLocalDateToMidnight(before,site.timezone);
    if(+end!==+addDaysInSiteTimezone(start,1,site.timezone))throw new Error('Rehearsal is limited to one local day');
    const store=new CompactHistoryStore(pool,15000,async client=>{
        // Re-check pause inside the mutation transaction so a resume cannot race a
        // rehearsal trim, matching the reviewed production guard.
        const result=await client.query<{paused:boolean}>('SELECT paused FROM "HistoryArchiveControl" WHERE id=true FOR SHARE');
        if(result.rows[0]?.paused!==true)throw new Error('Pause the archive job before rehearsing');
    });const reader=new CompactHistoryReader(store,site.timezone);
    const original=(await store.readVerificationSnapshot(siteId,start,end)).raw;
    if(!original.length)throw new Error('Retained raw samples required');
    const beforeRevision=(await pool.query<{revision:string;raw_pruned:boolean}>('SELECT revision,raw_pruned FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[siteId,start])).rows[0];
    if(beforeRevision?.raw_pruned)throw new Error('Restore the day before rehearsing');
    const totals=await reader.getCycleAggregates(siteId,start,end);
    const coverage=await reader.getDailyCoverage(siteId,start,end,site.timezone);
    const tags=(await pool.query('SELECT * FROM "LoadTag" WHERE site_id=$1 ORDER BY id',[siteId])).rows;
    let recoveryRevision:string|undefined;
    let report:Awaited<ReturnType<typeof runHistoryArchive>>|undefined;
    try {
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true,site_ids=$1,from_date=$2,before_date=$3 WHERE id=true',[[siteId],from,before]);
        const options={now:new Date(),retentionDays:3,maxDays:1,maxTimeMs:30000,maxEstimatedBytes:4*1024*1024,readsEnabled:true};
        report=await runHistoryArchive(new HistoryArchiveRepo(pool),options);
        const archive=(await pool.query<{revision:string;raw_pruned:boolean}>('SELECT revision,raw_pruned FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[siteId,start])).rows[0];
        if(archive?.raw_pruned)recoveryRevision=archive.revision;
        if(report.days[0]?.status!=='trimmed'||!recoveryRevision)throw new Error('Expected one verified trim');
        deepStrictEqual(await reader.getRawEnergyData(siteId,start,end),original);
        deepStrictEqual(await reader.getCycleAggregates(siteId,start,end),totals);
        deepStrictEqual(await reader.getDailyCoverage(siteId,start,end,site.timezone),coverage);
        deepStrictEqual((await pool.query('SELECT * FROM "LoadTag" WHERE site_id=$1 ORDER BY id',[siteId])).rows,tags);
        const repeat=await runHistoryArchive(new HistoryArchiveRepo(pool),options);
        if(repeat.days.length)throw new Error('Repeat processed a completed day');
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=true WHERE id=true');
        if((await runHistoryArchive(new HistoryArchiveRepo(pool),options)).stopped!=='paused')throw new Error('Pause failed');
        await store.restoreDay(siteId,start,recoveryRevision);recoveryRevision=undefined;
        deepStrictEqual((await store.readVerificationSnapshot(siteId,start,end)).raw,original);
        const rebuilt=await store.finalizeDay(siteId,start);
        if(!rebuilt.revision)throw new Error('Restored day finalization failed');
        await store.trimDay(siteId,start,rebuilt.revision,new Date());recoveryRevision=rebuilt.revision;
        await store.writeEnergyDataBatch([{...original[0],grid_power:original[0].grid_power+1,battery_soc:null}]);
        recoveryRevision=undefined;
        deepStrictEqual((await store.readVerificationSnapshot(siteId,start,end)).raw,[{...original[0],grid_power:original[0].grid_power+1},...original.slice(1)]);
        await store.writeEnergyDataBatch([original[0]]);
        deepStrictEqual((await store.readVerificationSnapshot(siteId,start,end)).raw,original);
        await store.finalizeDay(siteId,start);
        console.log(JSON.stringify({environment:'Dev',samples:original.length,exactChartRecovery:true,exactBillingInputs:true,exactCoverage:true,
            tagsPreserved:true,repeatSkipped:true,pauseVerified:true,exactRawRestoration:true,partialCorrectionPreservesUntouchedSamples:true,
            estimatedBytes:report.estimatedBytes,teslaRequests:0,productionChanges:false},null,2));
    } finally {
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=true WHERE id=true');
        // Check persisted state even if a network failure hid a committed trim result.
        const archive=(await pool.query<{revision:string;raw_pruned:boolean}>('SELECT revision,raw_pruned FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[siteId,start])).rows[0];
        if(archive?.raw_pruned)await store.restoreDay(siteId,start,recoveryRevision??archive.revision);
        const raw=(await store.readVerificationSnapshot(siteId,start,end)).raw;
        if(raw.length===original.length)await store.writeEnergyDataBatch(original);
        deepStrictEqual((await store.readVerificationSnapshot(siteId,start,end)).raw,original);
        await store.finalizeDay(siteId,start);
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=true,trim=$1,site_ids=$2,from_date=$3,before_date=$4 WHERE id=true',
            [initial.trim,initial.site_ids,initial.from_date,initial.before_date]);
    }
}
run().catch(()=>{console.error('Dev archival rehearsal failed; check the paused control and recovery state. Connection/sample details withheld.');process.exitCode=1;}).finally(()=>pool.end());
