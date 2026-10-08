import 'dotenv/config';
import { Pool } from 'pg';
import { statSync, writeFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert';
import { CompactHistoryStore } from '../src/lib/prototypes/compact-history-store';
import { CompactHistoryReader } from '../src/lib/prototypes/compact-history-reader';
import { rollupDay } from '../src/lib/prototypes/compact-energy';
import { addDaysInSiteTimezone, getSiteMidnight } from '../src/lib/date-utils';

let stage='arguments';
/** Local restored fixture only. Never uses DATABASE_URL or Tesla. */
async function run() {
    const [socket,database,output,...extra]=process.argv.slice(2);
    if (extra.length || !socket || !/^\/private\/tmp\/compact-energy-pg-[A-Za-z0-9-]+$/.test(socket)
        || (statSync(socket).mode & 0o777)!==0o700 || database!=='compact_production_archive' || !output) throw new Error('Invalid local fixture arguments');
    const pool=new Pool({ host:socket,port:55439,database,user:process.env.USER,max:2 });
    try {
        const store=new CompactHistoryStore(pool);
        const before=(await pool.query<{ count:string }>('SELECT count(*) AS count FROM "EnergyData"')).rows[0].count;
        const sites=await pool.query<{ id:string; timezone:string; latest:Date }>(`SELECT s.id,s.timezone,max(e.timestamp) AS latest
            FROM "Site" s JOIN "EnergyData" e ON s.id=e.site_id GROUP BY s.id,s.timezone ORDER BY s.id LIMIT 30`);
        let days=0,samples=0,incomplete=0,empty=0,retries=0;
        const payloads:number[]=[]; const durations:number[]=[];
        for (const site of sites.rows) {
            const reader=new CompactHistoryReader(store,site.timezone);
            const latest=getSiteMidnight(new Date(site.latest),site.timezone);
            for (const offset of [1,2,30,90,180]) {
                const start=addDaysInSiteTimezone(latest,-offset,site.timezone);
                const end=addDaysInSiteTimezone(start,1,site.timezone);
                stage='finalization'; const begun=performance.now();
                const result=await store.finalizeDay(site.id,start,new Date('2026-10-07T17:00:00Z'));
                durations.push(performance.now()-begun);
                if (result.status==='empty') { empty++; continue; }
                if (result.status==='busy') throw new Error('Unexpected busy fixture');
                stage='snapshot'; const snapshot=await store.readVerificationSnapshot(site.id,start,end);
                const day=snapshot.days[0];
                if (!day || snapshot.days.length!==1) throw new Error('Missing finalized day');
                stage='detail parity'; deepStrictEqual(await reader.getRawEnergyData(site.id,start,end),snapshot.raw);
                stage='rollup parity'; deepStrictEqual(day.summaries,rollupDay(snapshot.raw,start).sort((a,b)=>a.tariff_id-b.tariff_id || (a.tariff_schedule_id??-1)-(b.tariff_schedule_id??-1)));
                stage='coverage parity'; const coverage=await reader.getDailyCoverage(site.id,start,end,site.timezone);
                const maximumGap=snapshot.raw.reduce((gap,r,i)=>i ? Math.max(gap,+r.timestamp-+snapshot.raw[i-1].timestamp) : gap,0);
                if (coverage.length!==1 || coverage[0].count!==snapshot.raw.length || +coverage[0].first! !== +snapshot.raw[0].timestamp
                    || +coverage[0].last! !== +snapshot.raw.at(-1)!.timestamp || coverage[0].maxInteriorGapMs!==maximumGap) throw new Error('Coverage mismatch');
                const aggregate=await store.readAggregateSnapshot(site.id,start,end);
                if (aggregate.fullDays.length!==1 || aggregate.detail.days.length!==0 || aggregate.detail.raw.length!==0) throw new Error('Complete-day detail was loaded');
                stage='billing inputs'; if (day.attributionComplete) await reader.getCycleAggregates(site.id,start,end); else incomplete++;
                stage='idempotency'; const retry=await store.finalizeDay(site.id,start,new Date('2026-10-07T17:00:00Z'));
                if (retry.status!=='unchanged' || retry.revision!==result.revision) throw new Error('Idempotency failed');
                retries++; days++; samples+=snapshot.raw.length; payloads.push(day.archive.data.length);
            }
        }
        stage='raw count'; const after=(await pool.query<{ count:string }>('SELECT count(*) AS count FROM "EnergyData"')).rows[0].count;
        if (before!==after) throw new Error('Raw count changed');
        const allocation=await pool.query<{ table_name:string; total_bytes:string }>(`SELECT name AS table_name,
            pg_total_relation_size(('"'||name||'"')::regclass) AS total_bytes
            FROM (VALUES ('EnergyDayArchive'),('EnergyDaySummary')) AS tables(name)`);
        const report={ source:'isolated energy/site/tariff restore of production backup dated 2026-10-02',
            server:(await pool.query<{ server_version:string }>('SHOW server_version')).rows[0].server_version,
            sites:sites.rows.length,finalizedDays:days,samples,emptyDayWindows:empty,incompleteAttributionDays:incomplete,
            unchangedRetries:retries,rawRowCountPreserved:true,exactArchiveRecovery:true,exactRollupRecovery:true,exactCoverageRecovery:true,completeDayReadsExcludeDetail:true,
            payloadBytes:{ min:Math.min(...payloads),max:Math.max(...payloads),mean:payloads.reduce((s,n)=>s+n,0)/payloads.length },
            finalizationMs:{ mean:durations.reduce((s,n)=>s+n,0)/durations.length,max:Math.max(...durations) },
            allocatedBytes:allocation.rows.map(r=>({ table:r.table_name,bytes:Number(r.total_bytes) })),
            limitation:'bounded non-random sample; no live reader activation or raw deletion; attribution may remain incomplete' };
        stage='report'; writeFileSync(output,JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
    } finally { await pool.end(); }
}
run().catch(()=>{ console.error(`Local archive validation failed at ${stage}; source details withheld.`); process.exitCode=1; });
