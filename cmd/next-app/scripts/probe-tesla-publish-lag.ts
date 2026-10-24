/**
 * Measure how long after a 5-minute interval ends Tesla's calendar_history
 * starts returning its sample. Polls one site's day history and logs when the
 * newest sample changes. Read-only against Tesla; writes nothing to EnergyData.
 *
 *   npx tsx scripts/probe-tesla-publish-lag.ts <siteId> [minutes=25] [pollSeconds=30]
 */
import 'dotenv/config';
import {pool} from '../src/lib/db';
import {SiteRepo} from '../src/lib/site-repo';
import {createTeslaClientForSite} from '../src/lib/tesla-client-factory';
import {getSiteMidnight} from '../src/lib/date-utils';

const INTERVAL_MS=5*60*1000;

async function run():Promise<void> {
    const [siteId,minutesArg='25',pollArg='30']=process.argv.slice(2);
    if(!siteId)throw new Error('Site ID required');
    const site=await new SiteRepo().getSite(siteId);
    if(!site?.timezone)throw new Error('Site not found or has no timezone');
    const client=await createTeslaClientForSite(siteId);
    if(!client)throw new Error('No Tesla credentials for site');
    const quiet=console.log;console.log=()=>{};
    const deadline=Date.now()+Number(minutesArg)*60000;
    let newest=0;
    const lags:number[]=[];
    try {
        while(Date.now()<deadline) {
            const polledAt=Date.now();
            const rows=await client.getEnergyHistory(siteId,getSiteMidnight(new Date(),site.timezone),new Date(),'day',site.timezone);
            const latest=Math.max(0,...rows.map(r=>+new Date(r.timestamp)));
            if(latest>newest) {
                // Lag from the end of the newest interval to the first poll that saw it.
                const lagS=Math.round((polledAt-(latest+INTERVAL_MS))/1000);
                if(newest)lags.push(lagS);
                quiet(JSON.stringify({polledAt:new Date(polledAt).toISOString(),newestSample:new Date(latest).toISOString(),samples:rows.length,lagSeconds:lagS,first:!newest}));
                newest=latest;
            }
            await new Promise(resolve=>setTimeout(resolve,Number(pollArg)*1000));
        }
    } finally {console.log=quiet;}
    const sorted=[...lags].sort((a,b)=>a-b);
    console.log(JSON.stringify({observedTransitions:lags.length,lagSeconds:sorted,median:sorted[Math.floor(sorted.length/2)]??null,max:sorted.at(-1)??null}));
}
run().catch(error=>{console.error(error instanceof Error?error.message:'Probe failed');process.exitCode=1;}).finally(()=>pool.end());
