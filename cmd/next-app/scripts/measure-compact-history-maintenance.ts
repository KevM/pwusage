import 'dotenv/config';
import {Pool} from 'pg';
import {writeFileSync} from 'node:fs';
import {CompactHistoryStore} from '../src/lib/prototypes/compact-history-store';
import {runCompactMaintenance} from '../src/lib/prototypes/compact-history-maintenance';
import {PostgresTransferMeter,type TransferMetrics} from '../src/lib/prototypes/postgres-transfer-meter';
import {addDaysInSiteTimezone,getSiteMidnight,formatSiteDate} from '../src/lib/date-utils';
let stage='arguments';
/** Private backup fixture only; never uses DATABASE_URL or Tesla. No raw deletion. */
async function run():Promise<void> {
    const [socket,database,output,...extra]=process.argv.slice(2);
    if(!socket||database!=='compact_production_archive'||!output||extra.length)throw new Error('Expected local backup fixture');
    const meter=new PostgresTransferMeter(socket);await meter.start();
    const pool=new Pool({host:meter.host,port:55439,database,user:process.env.USER,max:1,ssl:false});
    const transfer:{preview:TransferMetrics[];apply:TransferMetrics[];repeat:TransferMetrics[]}={preview:[],apply:[],repeat:[]};
    let finalizedDays=0,emptyDays=0,sampleCountOrCoverageWarnings=0,attributionIncompleteDays=0;
    const started=performance.now();
    try {
        await pool.query('SELECT 1');
        const store=new CompactHistoryStore(pool);
        const before=(await pool.query<{n:string}>('SELECT count(*) AS n FROM "EnergyData"')).rows[0].n;
        const sites=(await pool.query<{id:string;timezone:string;latest:Date}>(`SELECT s.id,s.timezone,max(e.timestamp) AS latest FROM "Site" s
            JOIN "EnergyData" e ON s.id=e.site_id GROUP BY s.id,s.timezone ORDER BY count(*) DESC,s.id LIMIT 3`)).rows;
        for(const site of sites) {
            const end=getSiteMidnight(site.latest,site.timezone),start=addDaysInSiteTimezone(end,-30,site.timezone);
            const options={siteId:site.id,from:formatSiteDate(start,site.timezone),before:formatSiteDate(end,site.timezone),now:new Date('2026-10-07T18:00:00Z')};
            stage='preview';const preview=await meter.measure(()=>runCompactMaintenance(store,options));transfer.preview.push(preview.transfer);
            emptyDays+=preview.value.days.filter(d=>d.status==='empty').length;sampleCountOrCoverageWarnings+=preview.value.days.filter(d=>d.needsRepair).length;
            let remaining=preview.value.remaining.length;
            for(let run=0;remaining&&run<5;run++) {
                stage='apply';const apply=await meter.measure(()=>runCompactMaintenance(store,{...options,apply:true}));transfer.apply.push(apply.transfer);
                finalizedDays+=apply.value.days.filter(d=>d.status==='finalized').length;
                if(apply.value.stopped==='busy'||apply.value.remaining.length>=remaining)throw new Error('Unexpected stalled maintenance');
                remaining=apply.value.remaining.length;
            }
            if(remaining)throw new Error('Continuation limit exceeded');
            stage='repeat';const repeat=await meter.measure(()=>runCompactMaintenance(store,{...options,apply:true}));transfer.repeat.push(repeat.transfer);
            if(repeat.value.remaining.length||repeat.value.days.some(d=>d.status==='finalized'))throw new Error('Repeated maintenance wrote unexpectedly');
            attributionIncompleteDays+=repeat.value.days.filter(d=>d.attributionComplete===false).length;
        }
        const after=(await pool.query<{n:string}>('SELECT count(*) AS n FROM "EnergyData"')).rows[0].n;
        if(before!==after)throw new Error('Raw sample count changed');
        const allocation=(await pool.query<{table_name:string;bytes:string}>(`SELECT name AS table_name,pg_total_relation_size(('"'||name||'"')::regclass) AS bytes
            FROM (VALUES ('EnergyDayArchive'),('EnergyDaySummary')) AS t(name)`)).rows;
        const storedDays=Number((await pool.query<{n:string}>('SELECT count(*) AS n FROM "EnergyDayArchive"')).rows[0].n);
        const totalBytes=allocation.reduce((sum,r)=>sum+Number(r.bytes),0);
        const average=(rows:TransferMetrics[])=>({bytes:rows.reduce((sum,r)=>sum+r.bytes,0)/rows.length,selectRequests:rows.reduce((sum,r)=>sum+r.selectRequests,0)/rows.length,requests:rows.reduce((sum,r)=>sum+r.requests,0)/rows.length});
        const report={source:'isolated energy/site/tariff backup dated 2026-10-02',sites:sites.length,dayWindows:sites.length*30,finalizedDays,emptyDays,sampleCountOrCoverageWarnings,attributionIncompleteDays,rawRowCountPreserved:true,
            preview:{runs:transfer.preview.length,mean:average(transfer.preview)},applyChunks:{runs:transfer.apply.length,mean:average(transfer.apply),totalBytes:transfer.apply.reduce((sum,r)=>sum+r.bytes,0)},
            repeat:{runs:transfer.repeat.length,mean:average(transfer.repeat)},elapsedMs:performance.now()-started,
            allocation:allocation.map(r=>({table:r.table_name,bytes:Number(r.bytes)})),storedDays,totalBytes,extrapolatedMbPerSiteYear:totalBytes/storedDays*365/1e6,
            limits:'31 local days / 7 attempted days per apply / 45-second between-day soft budget / two recent completed days retained',
            limitations:'Nonrandom three-site 30-day sample. Local plaintext backend protocol bytes exclude TLS/TCP/provider accounting, site/auth/endpoint/browser traffic. Allocation includes current indexes/TOAST and fixed small-table overhead, not bloat/replicas/backups/other application tables. Raw rows remain: no space freed and no paid recovery.'};
        stage='report';writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
    } finally {await pool.end();await meter.close();}
}
run().catch(()=>{console.error(`Local maintenance measurement failed at ${stage}; source details withheld.`);process.exitCode=1;});
