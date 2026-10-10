import 'dotenv/config';
import {readFileSync} from 'node:fs';
import {pool} from '../src/lib/db';
import {parseRestorePlan,restoreHistoryPlan,HistoryArchiveRecoveryRepo} from '../src/lib/history-archive-recovery';

/** Preview is read-only; apply consumes explicit revisions from the reviewed JSON. */
async function run():Promise<void> {
    const [action,...args]=process.argv.slice(2);
    const repo=new HistoryArchiveRecoveryRepo(pool);
    if(action==='preview') {
        const all=args.length===1&&args[0]==='--all';
        if(!all&&(!args.length||args.length>100||args.some(site=>!site.trim()||site.startsWith('--'))))throw new Error('Preview requires explicit site IDs or --all');
        console.log(JSON.stringify(await repo.preview(all?null:args),null,2));
        return;
    }
    if(action!=='apply'||args.length!==1)throw new Error('Usage: preview SITE_ID... | preview --all | apply REVIEWED_JSON_FILE');
    const input:unknown=JSON.parse(readFileSync(args[0],'utf8'));
    const plan=parseRestorePlan(input);
    const report=await restoreHistoryPlan(repo,plan);
    console.log(JSON.stringify(report,null,2));
    if(report.stopped!=='complete')process.exitCode=2;
}
run().catch(error=>{console.error(error instanceof Error?error.message:'History restoration failed');process.exitCode=1;}).finally(()=>pool.end());
