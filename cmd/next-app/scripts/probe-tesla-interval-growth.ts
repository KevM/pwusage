/**
 * Check whether Tesla's newest calendar_history sample keeps changing after it
 * first appears (an in-progress interval) or is final when published. Polls one
 * site's day history and logs the newest sample's energy fields whenever they
 * change. Read-only against Tesla.
 *
 *   npx tsx scripts/probe-tesla-interval-growth.ts <siteId> [minutes=7] [pollSeconds=20]
 */
import 'dotenv/config';
import {pool} from '../src/lib/db';
import {SiteRepo} from '../src/lib/site-repo';
import {createTeslaClientForSite} from '../src/lib/tesla-client-factory';
import {getSiteMidnight} from '../src/lib/date-utils';

async function run():Promise<void> {
    const [siteId,minutesArg='7',pollArg='20']=process.argv.slice(2);
    if(!siteId)throw new Error('Site ID required');
    const site=await new SiteRepo().getSite(siteId);
    if(!site?.timezone)throw new Error('Site not found or has no timezone');
    const client=await createTeslaClientForSite(siteId);
    if(!client)throw new Error('No Tesla credentials for site');
    const quiet=console.log;console.log=()=>{};
    const deadline=Date.now()+Number(minutesArg)*60000;
    const seen=new Map<string,string>();
    try {
        while(Date.now()<deadline) {
            const rows=await client.getEnergyHistory(siteId,getSiteMidnight(new Date(),site.timezone),new Date(),'day',site.timezone);
            // The two newest samples: one may still be filling while the other is settled.
            for(const row of rows.slice(-2)) {
                const {timestamp,...fields}=row as unknown as Record<string,unknown>;
                const key=String(timestamp);const value=JSON.stringify(fields);
                if(seen.get(key)!==value) {
                    quiet(JSON.stringify({polledAt:new Date().toISOString(),sample:key,changed:seen.has(key),fields}));
                    seen.set(key,value);
                }
            }
            await new Promise(resolve=>setTimeout(resolve,Number(pollArg)*1000));
        }
    } finally {console.log=quiet;}
}
run().catch(error=>{console.error(error instanceof Error?error.message:'Probe failed');process.exitCode=1;}).finally(()=>pool.end());
