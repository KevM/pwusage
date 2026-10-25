/**
 * Convert v1 `EnergyDayArchive` records to day record v2 in place
 * (docs/plans/2026-10-24-day-record-v2.md, "Migrating existing archives").
 * Preview by default: every day is decoded and verified read-only and nothing
 * is written. `--apply` writes each verified day in its own transaction under
 * the per-site claim. A day whose v2 record would not read back exactly as the
 * v1 archive does stays v1 and is listed with its reason. Re-running skips v2
 * records, so an interrupted run resumes where it stopped. Raw "EnergyData"
 * rows are never read or written; days that still have them convert too (the
 * raw rows stay until the cutover, and finalization keeps the converted record
 * while it matches them).
 *
 *   npx tsx scripts/convert-archives-v2.ts [--site-id <id>]... [--apply] [--max-days 500] [--max-mb 16]
 *
 * `--max-mb` caps the run's conservative read reservation (stored payload plus
 * a fixed per-day overhead; measured real cost is a few KB per day), to stay
 * well inside Supabase's 5 GB/month egress. Output has counts, site IDs, days
 * and reasons only: no samples, payloads or tokens.
 */
import 'dotenv/config';
import {pool} from '../src/lib/db';
import {CompactHistoryStore} from '../src/lib/prototypes/compact-history-store';
import {ConversionUsageError,V1ConversionPgRepo,parseConversionArgs,runV1Conversion} from '../src/lib/prototypes/compact-v1-conversion';

async function run():Promise<void> {
    const options=parseConversionArgs(process.argv.slice(2));
    try {
        const store=new CompactHistoryStore(pool,15000,async client=>{
            // Hold the archive control row through COMMIT, as the archive job's phases do,
            // so a conversion never interleaves with a control edit.
            const control=await client.query('SELECT 1 FROM "HistoryArchiveControl" WHERE id=true FOR SHARE');
            if(!control.rowCount)throw new Error('Missing archive control');
        });
        const report=await runV1Conversion(new V1ConversionPgRepo(pool,store),{...options,now:new Date()});
        console.log(JSON.stringify(report,null,2));
    } finally {await pool.end();}
}
run().catch(error=>{
    console.error(error instanceof ConversionUsageError?error.message:'Archive conversion failed; days already converted stay converted and a re-run resumes. No raw rows are touched.');
    process.exitCode=1;
});
