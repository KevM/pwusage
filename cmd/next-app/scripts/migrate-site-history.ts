/**
 * Backfill one site's raw history from Tesla back to Site.installed, then
 * archive every finished day before the 2-day floor. Preview by default;
 * `--apply` writes. Deletes nothing.
 *
 *   npx tsx scripts/migrate-site-history.ts --site-id <id> [--apply] [--skip-backfill | --skip-archive]
 */
import 'dotenv/config';
import {pool} from '../src/lib/db';
import {EnergyRepo} from '../src/lib/energy-repo';
import {migrateSiteHistory,parseMigrationArgs,type BackfillDeps,type MigrationSite} from '../src/lib/history-migration';
import {Importer,planMissingWindows} from '../src/lib/importer';
import {CompactHistoryStore} from '../src/lib/prototypes/compact-history-store';
import {SiteRepo} from '../src/lib/site-repo';
import {createTeslaClientForSite} from '../src/lib/tesla-client-factory';

class OperatorError extends Error {}

async function loadSite(siteId:string):Promise<MigrationSite> {
    const site=await new SiteRepo().getSite(siteId);
    if(!site)throw new OperatorError('Site not found');
    // Migration must fail rather than fall back to UTC day boundaries.
    if(!site.timezone)throw new OperatorError('Site has no timezone');
    return {id:site.id,timezone:site.timezone,installed:new Date(site.installed)};
}

async function run():Promise<void> {
    const options=parseMigrationArgs(process.argv.slice(2));
    try {
        const site=await loadSite(options.siteId);
        const energyRepo=new EnergyRepo();
        let importer:Importer|null=null;
        if(options.apply&&!options.skipBackfill) {
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
        };
        const report=await migrateSiteHistory({site,backfill,store:new CompactHistoryStore(pool)},{...options,now:new Date()});
        // No IDs, tokens, tariffs or sample arrays in operator output.
        console.log(JSON.stringify(report,null,2));
    } finally {await pool.end();}
}
run().catch(error=>{
    console.error(error instanceof OperatorError
        ? error.message
        : 'Site history migration failed. Check arguments, migrations, site timezone and Tesla access. No raw deletion is performed; backfilled rows and finalized days remain committed, and a re-run resumes.');
    process.exitCode=1;
});
