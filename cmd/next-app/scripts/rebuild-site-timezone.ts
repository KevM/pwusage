/**
 * Change a site's timezone and re-key its stored days to the new local
 * midnights in one transaction (CompactHistoryStore.rebuildTimezone;
 * docs/plans/2026-10-24-day-record-v2.md, "Timezone changes"). No Tesla
 * request, so tokenless sites work too. Preview by default: the rebuild runs and
 * rolls back. `--apply` commits.
 *
 *   npx tsx scripts/rebuild-site-timezone.ts --site-id <id> [--timezone <IANA name>] [--apply]
 *
 * Without --timezone the site's Tesla-reported timezone (Site.json
 * installation_time_zone) is used: the one `upsertSite` keeps back while the
 * site has pruned days. Output has counts only: no samples or tokens.
 */
import 'dotenv/config';
import {pool} from '../src/lib/db';
import {CompactHistoryStore} from '../src/lib/prototypes/compact-history-store';

class OperatorError extends Error {}

function parseArgs(args:string[]) {
    const options={siteId:'',timezone:'',apply:false};
    for(let i=0;i<args.length;i++) {
        const key=args[i];
        if(key==='--apply') {options.apply=true;continue;}
        const value=args[++i];
        if(!value||value.startsWith('--'))throw new OperatorError(`Missing value for ${key}`);
        if(key==='--site-id')options.siteId=value;
        else if(key==='--timezone')options.timezone=value;
        else throw new OperatorError(`Unknown argument ${key}`);
    }
    if(!options.siteId)throw new OperatorError('Usage: --site-id <id> [--timezone <IANA name>] [--apply]');
    return options;
}

async function run():Promise<void> {
    const options=parseArgs(process.argv.slice(2));
    try {
        let timezone=options.timezone;
        if(!timezone) {
            const site=(await pool.query<{reported:string|null}>(`SELECT json->>'installation_time_zone' AS reported FROM "Site" WHERE id=$1`,[options.siteId])).rows[0];
            if(!site)throw new OperatorError('Site not found');
            if(!site.reported)throw new OperatorError('Tesla reported no timezone for this site; pass --timezone');
            timezone=site.reported;
        }
        try {new Intl.DateTimeFormat('en-US',{timeZone:timezone});} catch {throw new OperatorError(`Unknown timezone ${timezone}`);}
        // No transaction budget: a multi-year site re-encodes every pruned day in one transaction.
        const store=new CompactHistoryStore(pool,undefined,async client=>{
            // Hold the archive control row through COMMIT, as the archive job's phases do.
            const control=await client.query('SELECT 1 FROM "HistoryArchiveControl" WHERE id=true FOR SHARE');
            if(!control.rowCount)throw new Error('Missing archive control');
        });
        const result=await store.rebuildTimezone(options.siteId,timezone,{apply:options.apply,now:new Date()});
        console.log(JSON.stringify({mode:options.apply?'apply':'preview',to:timezone,...result},null,2));
        if(result.status==='busy')process.exitCode=2;
    } finally {await pool.end();}
}
run().catch(error=>{
    const code=typeof (error as {code?:unknown})?.code==='string'?` (database error ${(error as {code:string}).code})`:'';
    console.error(error instanceof OperatorError?error.message:`Timezone rebuild failed${code}; nothing was changed (one transaction).`);
    process.exitCode=1;
});
