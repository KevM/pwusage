/**
 * Check how Tesla's calendar_history day lines up with its 5-minute sample
 * labels: fetch two consecutive site-local days at 5-minute resolution plus
 * Tesla's own daily totals, and compare the day total with the sum of samples
 * labeled 00:00–23:55 (label = interval start) versus 00:05–24:00 (label =
 * interval end). Read-only against Tesla.
 *
 *   npx tsx scripts/probe-tesla-day-boundary.ts <siteId> <YYYY-MM-DD>
 */
import 'dotenv/config';
import {pool} from '../src/lib/db';
import {SiteRepo} from '../src/lib/site-repo';
import {createTeslaClientForSite} from '../src/lib/tesla-client-factory';
import {addDaysInSiteTimezone,parseSiteLocalDateToMidnight} from '../src/lib/date-utils';

const FIELDS=['grid_energy_imported','solar_energy_exported','total_home_usage','battery_energy_exported'] as const;

async function run():Promise<void> {
    const [siteId,date]=process.argv.slice(2);
    if(!siteId||!/^\d{4}-\d{2}-\d{2}$/.test(date??''))throw new Error('Usage: <siteId> <YYYY-MM-DD>');
    const site=await new SiteRepo().getSite(siteId);
    if(!site?.timezone)throw new Error('Site not found or has no timezone');
    const client=await createTeslaClientForSite(siteId);
    if(!client)throw new Error('No Tesla credentials for site');
    const tz=site.timezone;
    const d0=parseSiteLocalDateToMidnight(date,tz),d1=addDaysInSiteTimezone(d0,1,tz),d2=addDaysInSiteTimezone(d1,1,tz);
    const quiet=console.log;console.log=()=>{};
    try {
        const day=(start:Date,end:Date)=>client.getEnergyHistory(siteId,start,new Date(+end-1000),'day',tz);
        const [a,b,totals]=await Promise.all([day(d0,d1),day(d1,d2),client.getEnergyHistory(siteId,d0,new Date(+d2-1000),'week',tz)]);
        const label=(r:{timestamp:string})=>new Date(r.timestamp);
        const sum=(rows:Record<string,unknown>[],f:string)=>rows.reduce((n,r)=>n+Number(r[f]??0),0);
        const aRows=a as unknown as Record<string,unknown>[],bRows=b as unknown as Record<string,unknown>[];
        const bFirst=bRows.find(r=>+new Date(String(r.timestamp))===+d1);
        // Label = end: the day is samples labeled 00:05..24:00, i.e. drop day D's 00:00 and add D+1's 00:00.
        const endLabeled=[...aRows.filter(r=>+new Date(String(r.timestamp))!==+d0),...(bFirst?[bFirst]:[])];
        const dayTotal=(totals as unknown as Record<string,unknown>[]).find(r=>{
            const t=+new Date(String(r.timestamp));return t>=+d0&&t<+d1;
        });
        // Tesla's week period returns 30-minute buckets: compare the first hours of day D with
        // both labelings of the 5-minute samples (start: [h, h+25]; end: [h+5, h+30]).
        const buckets=(totals as unknown as Record<string,unknown>[]).filter(r=>{const t=+new Date(String(r.timestamp));return t>=+d0&&t<+d0+3*3600000;});
        const all=[...aRows,...bRows].map(r=>({t:+new Date(String(r.timestamp)),r}));
        const hourSum=(from:number,to:number,f:string)=>all.filter(x=>x.t>=from&&x.t<=to).reduce((n,x)=>n+Number(x.r[f]??0),0);
        quiet(JSON.stringify({hourly:buckets.map(bk=>{const h=+new Date(String(bk.timestamp));return {bucket:String(bk.timestamp),
            grid:{tesla:Number(bk.grid_energy_imported),startLabeled:hourSum(h,h+25*60000,'grid_energy_imported'),endLabeled:hourSum(h+5*60000,h+30*60000,'grid_energy_imported')},
            home:{tesla:Number(bk.total_home_usage),startLabeled:hourSum(h,h+25*60000,'total_home_usage'),endLabeled:hourSum(h+5*60000,h+30*60000,'total_home_usage')}};})},null,2));
        quiet(JSON.stringify({
            dayD:{samples:a.length,firstLabel:a[0]&&label(a[0]).toISOString(),lastLabel:a.at(-1)&&label(a.at(-1)!).toISOString()},
            dayD1:{samples:b.length,firstLabel:b[0]&&label(b[0]).toISOString()},
            dayStartUtc:d0.toISOString(),nextDayStartUtc:d1.toISOString(),
            teslaDailyTotalLabel:dayTotal?String(dayTotal.timestamp):null,
            compare:Object.fromEntries(FIELDS.map(f=>[f,{teslaDay:dayTotal?Number(dayTotal[f]):null,
                labels_0000_2355:sum(aRows,f),labels_0005_2400:sum(endLabeled,f),
                firstSampleOfD:Number(aRows[0]?.[f]??0),firstSampleOfD1:Number(bFirst?.[f]??0)}])),
        },null,2));
    } finally {console.log=quiet;}
}
run().catch(error=>{console.error(error instanceof Error?error.message:'Probe failed');process.exitCode=1;}).finally(()=>pool.end());
