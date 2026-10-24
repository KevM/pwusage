/**
 * Backfill whole site-local days from Tesla straight into compact archives,
 * without staging raw "EnergyData" rows or reading them back: one Tesla day
 * request (energy + SOE), tariff attribution in memory, one archive write.
 * Preview by default (fetch only); `--apply` writes. Days that still have raw
 * rows are skipped (their archive is owned by the raw source).
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

        const quiet=console.log;console.log=()=>{};
        const results:{day:string;samples:number;status:string;fetchMs:number;writeMs:number}[]=[];
        const started=performance.now();
        try {
            let next=0;
            await Promise.all(Array.from({length:options.concurrency},async()=>{
                while(next<days.length) {
                    const start=days[next++];const end=addDaysInSiteTimezone(start,1,site.timezone);
                    const day=start.toISOString();
                    const t0=performance.now();
                    // End 1 s before midnight so Tesla stays inside this day (see Importer.loadInterval).
                    const rows=(await importer.fetchRange(site,start,new Date(+end-1000),'day')).filter(r=>r.timestamp>=start&&r.timestamp<end);
                    const fetchMs=Math.round(performance.now()-t0);
                    let status='preview';const t1=performance.now();
                    if(options.apply) {
                        try {status=(await store.writeDayFromSamples(site.id,start,rows)).status;}
                        catch(error) {status=error instanceof Error&&/raw samples/.test(error.message)?'raw-present':'failed';}
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
    console.error(error instanceof OperatorError?error.message:'Compact backfill failed. Check arguments, site timezone and Tesla access. No raw rows are written.');
    process.exitCode=1;
});
