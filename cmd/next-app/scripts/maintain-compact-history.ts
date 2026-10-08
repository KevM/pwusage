import 'dotenv/config';
import {pool} from '../src/lib/db';
import {CompactHistoryStore} from '../src/lib/prototypes/compact-history-store';
import {parseMaintenanceArgs,runCompactMaintenance} from '../src/lib/prototypes/compact-history-maintenance';

async function run():Promise<void> {
    const options=parseMaintenanceArgs(process.argv.slice(2));
    try {
        const report=await runCompactMaintenance(new CompactHistoryStore(pool),options);
        // No IDs, tokens, tariffs or sample arrays in operator output.
        console.log(JSON.stringify(report,null,2));
    } finally {await pool.end();}
}
run().catch(()=>{
    console.error('Compact maintenance failed. Check arguments, migrations, site timezone and archive integrity. No raw deletion or Tesla recovery is performed; earlier successfully finalized days remain committed.');
    process.exitCode=1;
});
