/**
 * Backfill one site's raw history from Tesla back to Site.installed, then
 * archive every finished day before the 2-day floor. Preview by default;
 * `--apply` writes. Deletes nothing.
 *
 *   npx tsx scripts/migrate-site-history.ts --site-id <id> [--apply] [--skip-backfill | --skip-archive] [--repair]
 *
 * Backfill pauses between passes so the site's own today-refresh can still take
 * the import lock; a multi-year site takes over an hour. The days between the
 * hardware install and utility provisioning never have data: once a run
 * confirms that gap it records Site.history_backfill_from, and later runs
 * start there instead of re-fetching it. A complete --apply run stamps
 * Site.history_migrated_at, which the admin Sites tab shows.
 *
 * --repair re-fetches days whose stored samples are short, gappy or not fully
 * tariff-attributed (the archive report's `repairable`), on or after the
 * backfill start, then re-archives them. Tesla usually still has those days
 * complete; the app's own imports had missed a few samples.
 */
import 'dotenv/config';
import {pool} from '../src/lib/db';
import {EnergyRepo} from '../src/lib/energy-repo';
import {isMigrationComplete,migrateSiteHistory,parseMigrationArgs,type BackfillDeps,type MigrationSite} from '../src/lib/history-migration';
import {Importer,planMissingWindows} from '../src/lib/importer';
import {CompactHistoryStore} from '../src/lib/prototypes/compact-history-store';
import {SiteRepo} from '../src/lib/site-repo';
import {createTeslaClientForSite} from '../src/lib/tesla-client-factory';
import {REFRESH_MIN_INTERVAL_MS} from '../src/lib/today-refresh';

/** Longer than today-refresh's min interval since our last import-lock stamp. */
const PASS_PAUSE_MS=REFRESH_MIN_INTERVAL_MS+5000;

class OperatorError extends Error {}

async function loadSite(siteRepo:SiteRepo,siteId:string):Promise<MigrationSite> {
    const site=await siteRepo.getSite(siteId);
    if(!site)throw new OperatorError('Site not found');
    // Migration must fail rather than fall back to UTC day boundaries.
    if(!site.timezone)throw new OperatorError('Site has no timezone');
    return {id:site.id,timezone:site.timezone,installed:new Date(site.installed),backfillFrom:await siteRepo.getHistoryBackfillFrom(site.id)};
}

async function run():Promise<void> {
    const options=parseMigrationArgs(process.argv.slice(2));
    try {
        const siteRepo=new SiteRepo();
        const site=await loadSite(siteRepo,options.siteId);
        const energyRepo=new EnergyRepo();
        let importer:Importer|null=null;
        if(options.apply&&(!options.skipBackfill||options.repair)) {
            const client=await createTeslaClientForSite(site.id);
            if(!client)throw new OperatorError('No Tesla credentials for site; re-authenticate via /login');
            importer=new Importer(client);
        }
        const backfill:BackfillDeps={
            plan:(s,start,end)=>planMissingWindows(energyRepo,s,start,end),
            ensure:(siteId,start,end,budget)=>{
                if(!importer)throw new Error('Backfill requires --apply');
                return importer.ensureDataForRange(siteId,start,end,undefined,budget);
            },
            pause:()=>new Promise(resolve=>setTimeout(resolve,PASS_PAUSE_MS)),
            recordBackfillFrom:(siteId,from)=>siteRepo.setHistoryBackfillFrom(siteId,from),
            refetch:(siteId,days,budget)=>{
                if(!importer)throw new Error('Repair requires --apply');
                return importer.refetchDays(siteId,days,budget);
            },
        };
        const report=await migrateSiteHistory({site,backfill,store:new CompactHistoryStore(pool)},{...options,now:new Date()});
        // Shown on the admin Sites tab.
        const markedMigrated=isMigrationComplete(report);
        if(markedMigrated)await siteRepo.setHistoryMigratedAt(site.id,new Date());
        // No IDs, tokens, tariffs or sample arrays in operator output.
        console.log(JSON.stringify({...report,markedMigrated},null,2));
    } finally {await pool.end();}
}
run().catch(error=>{
    console.error(error instanceof OperatorError
        ? error.message
        : 'Site history migration failed. Check arguments, migrations, site timezone and Tesla access. No raw deletion is performed; backfilled rows and finalized days remain committed, and a re-run resumes.');
    process.exitCode=1;
});
