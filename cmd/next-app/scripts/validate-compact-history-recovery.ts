import 'dotenv/config';
import {Pool} from 'pg';
import {writeFileSync} from 'node:fs';
import {deepStrictEqual} from 'node:assert';
import {CompactHistoryStore} from '../src/lib/prototypes/compact-history-store';
import {CompactHistoryReader} from '../src/lib/prototypes/compact-history-reader';
import {PostgresTransferMeter,type TransferMetrics} from '../src/lib/prototypes/postgres-transfer-meter';
import {addDaysInSiteTimezone,getSiteMidnight} from '../src/lib/date-utils';

let stage='arguments';
/** Destructive operations are confined to selected days in a disposable backup fixture; restores every selected day. */
async function run():Promise<void> {
    const [socket,database,output,...extra]=process.argv.slice(2);
    if(!socket||database!=='compact_production_archive'||!output||extra.length)throw new Error('Expected disposable backup fixture');
    const meter=new PostgresTransferMeter(socket);await meter.start();
    const pool=new Pool({host:meter.host,port:55439,database,user:process.env.USER,max:1,ssl:false});
    const costs:{trim:TransferMetrics[];restore:TransferMetrics[]}={trim:[],restore:[]};
    let testedDays=0,samples=0,incompleteSkipped=0,emptySkipped=0;
    try {
        await pool.query('SELECT 1');const store=new CompactHistoryStore(pool);
        const before=(await pool.query<{n:string}>('SELECT count(*) AS n FROM "EnergyData"')).rows[0].n;
        const sites=(await pool.query<{id:string;timezone:string;latest:Date}>(`SELECT s.id,s.timezone,max(e.timestamp) AS latest FROM "Site" s
            JOIN "EnergyData" e ON s.id=e.site_id GROUP BY s.id,s.timezone ORDER BY count(*) DESC,s.id LIMIT 5`)).rows;
        const now=new Date('2026-10-07T20:00:00Z');
        for(const site of sites)for(const offset of [1,30]) {
            const start=addDaysInSiteTimezone(getSiteMidnight(site.latest,site.timezone),-offset,site.timezone);
            const end=addDaysInSiteTimezone(start,1,site.timezone);
            stage='finalize';const initial=await store.finalizeDay(site.id,start,now);
            if(initial.status==='empty') {emptySkipped++;continue;}
            if(initial.status==='busy'||!initial.revision)throw new Error('Unexpected fixture contention');
            if(!initial.attributionComplete) {incompleteSkipped++;continue;}
            stage='baseline';const original=(await store.readVerificationSnapshot(site.id,start,end)).raw;
            const reader=new CompactHistoryReader(store,site.timezone);
            const totals=await reader.getCycleAggregates(site.id,start,end);
            const coverage=await reader.getDailyCoverage(site.id,start,end,site.timezone);
            const checksum=(await pool.query<{checksum:string}>('SELECT checksum FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[site.id,start])).rows[0].checksum;
            stage='trim';const trimmed=await meter.measure(()=>store.trimDay(site.id,start,initial.revision!,now));costs.trim.push(trimmed.transfer);
            if(trimmed.value.status!=='trimmed'||trimmed.value.samples!==original.length)throw new Error('Trim mismatch');
            stage='pruned parity';deepStrictEqual(await reader.getRawEnergyData(site.id,start,end),original);
            deepStrictEqual(await reader.getCycleAggregates(site.id,start,end),totals);
            deepStrictEqual(await reader.getDailyCoverage(site.id,start,end,site.timezone),coverage);
            if((await store.readVerificationSnapshot(site.id,start,end)).raw.length)throw new Error('Raw rows remained');
            stage='restore';const restored=await meter.measure(()=>store.restoreDay(site.id,start,initial.revision!));costs.restore.push(restored.transfer);
            if(restored.value.samples!==original.length)throw new Error('Restore count mismatch');
            deepStrictEqual((await store.readVerificationSnapshot(site.id,start,end)).raw,original);
            stage='re-finalize';const rebuilt=await store.finalizeDay(site.id,start,now);
            if(rebuilt.status!=='finalized')throw new Error('Recovery finalization failed');
            if((await pool.query<{checksum:string}>('SELECT checksum FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[site.id,start])).rows[0].checksum!==checksum)throw new Error('Recovered archive changed');
            // Exercise partial correction after a second trim, then restore the original value.
            await store.trimDay(site.id,start,rebuilt.revision!,now);
            stage='late correction';const changed={...original[0],grid_power:original[0].grid_power+1,battery_soc:null};
            await store.writeEnergyDataBatch([changed]);
            const expected=[{...original[0],grid_power:changed.grid_power},...original.slice(1)];
            deepStrictEqual((await store.readVerificationSnapshot(site.id,start,end)).raw,expected);
            await store.writeEnergyDataBatch([original[0]]);
            deepStrictEqual((await store.readVerificationSnapshot(site.id,start,end)).raw,original);
            await store.finalizeDay(site.id,start,now);
            testedDays++;samples+=original.length;
        }
        stage='final count';const after=(await pool.query<{n:string}>('SELECT count(*) AS n FROM "EnergyData"')).rows[0].n;
        if(before!==after||!testedDays)throw new Error('Recovery sample counts failed');
        const average=(items:TransferMetrics[])=>({bytes:items.reduce((s,r)=>s+r.bytes,0)/items.length,selectRequests:items.reduce((s,r)=>s+r.selectRequests,0)/items.length});
        const report={source:'isolated source-table restore of production backup dated 2026-10-02',sites:sites.length,testedDays,samples,emptySkipped,incompleteSkipped,
            exactPostTrimCharts:true,exactPostTrimBillingInputs:true,exactPostTrimCoverage:true,exactRawRestoration:true,identicalRecoveredChartChecksum:true,
            partialLateCorrectionPreservesUntouchedSamplesAndSoc:true,rawRowCountRestored:true,trimMean:average(costs.trim),restoreMean:average(costs.restore),
            limitations:'Bounded nonrandom selected days; local plaintext database response bytes exclude TLS/TCP/provider/site/auth/browser accounting and frontend traffic. Not a production backup/whole-database restore rehearsal or authorization to trim production. No Tesla requests.'};
        stage='report';writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
    } finally {await pool.end();await meter.close();}
}
run().catch(()=>{console.error(`Local recovery validation failed at ${stage}; source details withheld.`);process.exitCode=1;});
