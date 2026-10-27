/**
 * Backfill site-local days from Tesla straight into compact day records
 * (`CompactHistoryStore.writeDay`): one Tesla day request (energy + SOE),
 * segments from the current tariff, one record write. Preview by default (fetch
 * only); `--apply` writes. Any day whose energy or SOE request fails is skipped
 * (`fetch-failed`), so a re-run never replaces stored SOC with nulls. A day
 * already written from a newer fetch is left as is (`superseded`). A day Tesla
 * answers with no samples is recorded as checked (`checked-empty`: an `empty`
 * day record); once that answer is final and older than the gap-heal window,
 * later runs (and import planning) skip the day (`settled-empty`) without a
 * Tesla request.
 *
 *   npx tsx scripts/backfill-compact-from-tesla.ts --site-id <id> --from YYYY-MM-DD --before YYYY-MM-DD [--apply] [--concurrency N]
 *
 * Site, tariffs and Tesla tokens come from DATABASE_URL. Set ARCHIVE_DATABASE_URL
 * to write the archives to a different database (e.g. benchmark into Dev while
 * using the live tokens, without rotating them from a copied database).
 */
import 'dotenv/config';
import {Pool} from 'pg';
import {pool} from '../src/lib/db';
import {addDaysInSiteTimezone,parseSiteLocalDateToMidnight} from '../src/lib/date-utils';
import {Importer} from '../src/lib/importer';
import {fetchDayForWrite,type FetchedDay} from '../src/lib/prototypes/compact-day-fetch';
import {CompactHistoryStore} from '../src/lib/prototypes/compact-history-store';
import {SiteRepo} from '../src/lib/site-repo';
import {createTeslaClientForSite} from '../src/lib/tesla-client-factory';

class OperatorError extends Error {}

function parseArgs(args:string[]) {
    const options={siteId:'',from:'',before:'',apply:false,concurrency:1};
    for(let i=0;i<args.length;i++) {
        const key=args[i];
        if(key==='--apply') {options.apply=true;continue;}
        const value=args[++i];
        if(!value||value.startsWith('--'))throw new OperatorError(`Missing value for ${key}`);
        if(key==='--site-id')options.siteId=value;
        else if(key==='--from')options.from=value;
        else if(key==='--before')options.before=value;
        else if(key==='--concurrency')options.concurrency=Number(value);
        else throw new OperatorError(`Unknown argument ${key}`);
    }
    if(!options.siteId||!/^\d{4}-\d{2}-\d{2}$/.test(options.from)||!/^\d{4}-\d{2}-\d{2}$/.test(options.before)||options.before<=options.from)
        throw new OperatorError('Usage: --site-id <id> --from YYYY-MM-DD --before YYYY-MM-DD [--apply] [--concurrency N]');
    if(!Number.isInteger(options.concurrency)||options.concurrency<1||options.concurrency>8)throw new OperatorError('--concurrency must be 1–8');
    return options;
}

async function run():Promise<void> {
    const options=parseArgs(process.argv.slice(2));
    const archivePool=process.env.ARCHIVE_DATABASE_URL?new Pool({connectionString:process.env.ARCHIVE_DATABASE_URL,ssl:{rejectUnauthorized:false},max:options.concurrency}):pool;
    try {
        const site=(await new SiteRepo().getSitesWithTariffs([options.siteId]))[0];
        if(!site?.timezone)throw new OperatorError('Site not found or has no timezone');
        const client=await createTeslaClientForSite(site.id);
        if(!client)throw new OperatorError('No Tesla credentials for site; re-authenticate via /login');
        const importer=new Importer(client);
        const store=new CompactHistoryStore(archivePool);
        const days:Date[]=[];
        for(let d=parseSiteLocalDateToMidnight(options.from,site.timezone),stop=parseSiteLocalDateToMidnight(options.before,site.timezone);d<stop;d=addDaysInSiteTimezone(d,1,site.timezone))days.push(d);

        // Days Tesla already answered empty, after they ended and outside the gap-heal window, are not fetched again.
        const settledEmpty=new Set((await store.getSettledEmptyDays(site.id,days[0]??new Date(0),addDaysInSiteTimezone(days.at(-1)??new Date(0),1,site.timezone),new Date())).map(d=>+d));

        const quiet=console.log;console.log=()=>{};
        const results:{day:string;samples:number;status:string;fetchMs:number;writeMs:number}[]=[];
        const started=performance.now();
        try {
            let next=0;
            await Promise.all(Array.from({length:options.concurrency},async()=>{
                while(next<days.length) {
                    const start=days[next++];
                    const day=start.toISOString();
                    if(settledEmpty.has(+start)) {results.push({day,samples:0,status:'settled-empty',fetchMs:0,writeMs:0});continue;}
                    const t0=performance.now();
                    // A failed energy or SOE request skips the day for a re-run (see fetchDayForWrite).
                    let fetched:FetchedDay;
                    try {fetched=await fetchDayForWrite(importer,site,start);}
                    catch {results.push({day,samples:0,status:'fetch-failed',fetchMs:Math.round(performance.now()-t0),writeMs:0});continue;}
                    const {rows,fetchedAt}=fetched;
                    const fetchMs=Math.round(performance.now()-t0);
                    let status='preview';const t1=performance.now();
                    if(options.apply) {
                        try {status=(await store.writeDay(site.id,start,rows,fetchedAt)).status;}
                        catch {status='failed';}
                    }
                    results.push({day,samples:rows.length,status,fetchMs,writeMs:Math.round(performance.now()-t1)});
                }
            }));
        } finally {console.log=quiet;}
        const totalMs=Math.round(performance.now()-started);
        const sum=(k:'fetchMs'|'writeMs')=>results.reduce((n,r)=>n+r[k],0);
        const statuses=results.reduce<Record<string,number>>((m,r)=>({...m,[r.status]:(m[r.status]??0)+1}),{});
        let archiveBytes:number|null=null;
        if(options.apply) {
            archiveBytes=Number((await archivePool.query<{bytes:string}>(`SELECT COALESCE(sum(pg_column_size(a.*)),0)::text AS bytes FROM "EnergyDayArchive" a
                WHERE site_id=$1 AND day_start>=$2 AND day_start<$3`,[site.id,days[0],addDaysInSiteTimezone(days.at(-1)!,1,site.timezone)])).rows[0].bytes);
        }
        // No IDs, tokens or samples in operator output beyond the requested site's day list.
        console.log(JSON.stringify({mode:options.apply?'apply':'preview',days:results.length,concurrency:options.concurrency,totalSeconds:+(totalMs/1000).toFixed(1),
            perDayMs:{fetch:Math.round(sum('fetchMs')/results.length),write:Math.round(sum('writeMs')/results.length)},
            samples:results.reduce((n,r)=>n+r.samples,0),statuses,archiveBytes},null,2));
    } finally {
        if(archivePool!==pool)await archivePool.end();
        await pool.end();
    }
}
run().catch(error=>{
    console.error(error instanceof OperatorError?error.message:'Compact backfill failed. Check arguments, site timezone and Tesla access.');
    process.exitCode=1;
});
