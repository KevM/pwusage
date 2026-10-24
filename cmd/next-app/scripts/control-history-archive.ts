import 'dotenv/config';
import {pool} from '../src/lib/db';
import {parseArchiveControlArgs} from '../src/lib/history-archive-control';

async function run():Promise<void> {
    const {action,sites,from,before}=parseArchiveControlArgs(process.argv.slice(2));
    if(action==='trim'&&process.env.COMPACT_HISTORY_READS_ENABLED!=='true')throw new Error('Enable compact readers before selecting trim mode');
    if(action==='pause')await pool.query('UPDATE "HistoryArchiveControl" SET paused=true WHERE id=true');
    if(action==='archive'||action==='archive-all'||action==='trim') {
        if(process.env.HISTORY_ARCHIVE_JOB_ENABLED!=='true')throw new Error('Enable HISTORY_ARCHIVE_JOB_ENABLED for the intended environment first');
        const existing=await pool.query<{id:string}>('SELECT id FROM "Site" WHERE id=ANY($1::text[]) AND user_id IS NOT NULL',[sites]);
        if(existing.rows.length!==sites.length)throw new Error('Unknown or unowned site');
        // archive and archive-all replace the cohort in archive-only mode; trim keeps
        // archive-all on (every owned site is still archived) and trims only the listed sites.
        if(action==='trim')await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true,site_ids=$1,from_date=$2,before_date=$3 WHERE id=true',[sites,from??null,before??null]);
        else await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=false,archive_all=$1,site_ids=$2,from_date=$3,before_date=$4 WHERE id=true',[action==='archive-all',sites,from??null,before??null]);
    }
    const control=await pool.query('SELECT paused,trim,archive_all,site_ids,from_date,before_date,last_run_at,last_report FROM "HistoryArchiveControl" WHERE id=true');
    if(!control.rows[0])throw new Error('Archive control migration missing');
    const retries=await pool.query(`SELECT reason,count(*)::int AS days,min(retry_after) AS next_retry FROM "HistoryArchiveRetry" GROUP BY reason ORDER BY reason`);
    console.log(JSON.stringify({control:control.rows[0],retries:retries.rows},null,2));
}
run().catch(error=>{console.error(error instanceof Error?error.message:'Archive control failed');process.exitCode=1;}).finally(()=>pool.end());
