import 'dotenv/config';
import { Pool } from 'pg';
import { writeFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert';
import type { EnergyData } from '../src/lib/db-types';
import type { CycleAggregateRow,DailyCoverageStat } from '../src/lib/energy-repo';
import { CompactHistoryStore } from '../src/lib/prototypes/compact-history-store';
import { CompactHistoryReader } from '../src/lib/prototypes/compact-history-reader';
import { PostgresTransferMeter,type TransferMetrics } from '../src/lib/prototypes/postgres-transfer-meter';
import { addDaysInSiteTimezone,getSiteMidnight } from '../src/lib/date-utils';

const measurements=['load_power','solar_power','grid_power','battery_power'] as const;
let stage='arguments';
interface Comparison {kind:string;raw:TransferMetrics;archived:TransferMetrics}
function compareTotals(reference:CycleAggregateRow[],actual:CycleAggregateRow[]):void {
    const sort=(rows:CycleAggregateRow[])=>[...rows].sort((a,b)=>+a.day-+b.day || a.tariff_id-b.tariff_id || (a.tariff_schedule_id??-1)-(b.tariff_schedule_id??-1));
    const left=sort(reference),right=sort(actual);if(left.length!==right.length) throw new Error('Total bucket mismatch');
    for(let i=0;i<left.length;i++) {
        if(+left[i].day!==+right[i].day || left[i].tariff_id!==right[i].tariff_id || left[i].tariff_schedule_id!==right[i].tariff_schedule_id) throw new Error('Total identity mismatch');
        for(const field of measurements) if(Math.abs(left[i][field]-right[i][field])>1e-9*Math.max(1,Math.abs(left[i][field]))) throw new Error('Total mismatch');
    }
}
async function run() {
    const [socket,database,output,...extra]=process.argv.slice(2);
    if(extra.length || !socket || database!=='compact_production_archive' || !output) throw new Error('Expected local restored fixture and output');
    const meter=new PostgresTransferMeter(socket);await meter.start();
    const pool=new Pool({host:meter.host,port:55439,database,user:process.env.USER,max:1,ssl:false});
    const comparisons:Comparison[]=[];
    const tariffCosts:TransferMetrics[]=[];
    const combinedCosts:{separate:TransferMetrics;combined:TransferMetrics}[]=[];
    const partialCosts:TransferMetrics[]=[];
    let finalized=0,empty=0,samples=0,incompleteBillWindows=0;
    try {
        await pool.query('SELECT 1'); // Exclude connection/startup traffic; serialize every measured operation.
        const store=new CompactHistoryStore(pool);
        const before=(await pool.query<{count:string}>('SELECT count(*) AS count FROM "EnergyData"')).rows[0].count;
        const sites=(await pool.query<{id:string;timezone:string;latest:Date}>(`SELECT s.id,s.timezone,max(e.timestamp) AS latest
            FROM "Site" s JOIN "EnergyData" e ON s.id=e.site_id GROUP BY s.id,s.timezone ORDER BY count(*) DESC,s.id LIMIT 5`)).rows;
        const rawRows=async(site:string,start:Date,end:Date):Promise<EnergyData[]>=>{
            const result=await pool.query<EnergyData>(`SELECT site_id,timestamp,tariff_id,tariff_schedule_id,load_power,solar_power,grid_power,battery_power,battery_soc
                FROM "EnergyData" WHERE site_id=$1 AND timestamp>=$2 AND timestamp<$3 ORDER BY timestamp`,[site,start,end]);
            return result.rows.map(r=>({...r,timestamp:new Date(r.timestamp),tariff_id:Number(r.tariff_id),tariff_schedule_id:r.tariff_schedule_id===null?null:Number(r.tariff_schedule_id),
                load_power:Number(r.load_power),solar_power:Number(r.solar_power),grid_power:Number(r.grid_power),battery_power:Number(r.battery_power),battery_soc:r.battery_soc===null?null:Number(r.battery_soc)}));
        };
        const rawTotals=async(site:string,start:Date,end:Date,tz:string):Promise<CycleAggregateRow[]>=>{
            const result=await pool.query<CycleAggregateRow>(`SELECT (date_trunc('day',timestamp AT TIME ZONE $4) AT TIME ZONE $4) AS day,
                tariff_id,tariff_schedule_id,SUM(load_power) AS load_power,SUM(solar_power) AS solar_power,SUM(grid_power) AS grid_power,SUM(battery_power) AS battery_power
                FROM "EnergyData" WHERE site_id=$1 AND timestamp>=$2 AND timestamp<$3 GROUP BY day,tariff_id,tariff_schedule_id ORDER BY day,tariff_id,tariff_schedule_id`,[site,start,end,tz]);
            return result.rows.map(r=>({...r,day:new Date(r.day),tariff_id:Number(r.tariff_id),tariff_schedule_id:r.tariff_schedule_id===null?null:Number(r.tariff_schedule_id),
                load_power:Number(r.load_power),solar_power:Number(r.solar_power),grid_power:Number(r.grid_power),battery_power:Number(r.battery_power)}));
        };
        const rawCoverage=async(site:string,start:Date,end:Date,tz:string):Promise<DailyCoverageStat[]>=>{
            const result=await pool.query<{key:string;count:number;first:Date;last:Date;gap:string}>(`WITH samples AS (
                SELECT timestamp,date_trunc('day',timestamp AT TIME ZONE $4) AS day,
                    LAG(timestamp) OVER (PARTITION BY date_trunc('day',timestamp AT TIME ZONE $4) ORDER BY timestamp) AS prev
                FROM "EnergyData" WHERE site_id=$1 AND timestamp>=$2 AND timestamp<$3)
                SELECT to_char(day,'YYYY-MM-DD') AS key,count(*)::int AS count,min(timestamp) AS first,max(timestamp) AS last,
                    COALESCE(max(EXTRACT(EPOCH FROM(timestamp-COALESCE(prev,timestamp)))*1000),0) AS gap FROM samples GROUP BY day ORDER BY day`,[site,start,end,tz]);
            return result.rows.map(r=>({localDayKey:r.key,count:r.count,first:new Date(r.first),last:new Date(r.last),maxInteriorGapMs:Number(r.gap)}));
        };
        for(const site of sites) {
            const end=getSiteMidnight(new Date(site.latest),site.timezone);
            const start=addDaysInSiteTimezone(end,-30,site.timezone);
            stage='local finalization';
            for(let day=start;day<end;day=addDaysInSiteTimezone(day,1,site.timezone)) {
                const result=await store.finalizeDay(site.id,day,new Date('2026-10-07T17:00:00Z'));
                if(result.status==='busy') throw new Error('Unexpected busy fixture');
                if(result.status==='empty') empty++;else finalized++;
            }
            const reader=new CompactHistoryReader(store,site.timezone);
            for(const [kind,from] of [['daily_chart',addDaysInSiteTimezone(end,-1,site.timezone)],['monthly_chart',start]] as const) {
                stage=kind;
                const baseline=await meter.measure(()=>rawRows(site.id,from,end));
                const archive=await meter.measure(()=>reader.getRawEnergyData(site.id,from,end));
                deepStrictEqual(archive.value,baseline.value);
                if(kind==='monthly_chart') samples+=baseline.value.length;
                comparisons.push({kind,raw:baseline.transfer,archived:archive.transfer});
            }
            stage='coverage';
            const baseCoverage=await meter.measure(()=>rawCoverage(site.id,start,end,site.timezone));
            const archiveCoverage=await meter.measure(()=>reader.getDailyCoverage(site.id,start,end,site.timezone));
            deepStrictEqual(archiveCoverage.value,baseCoverage.value);
            comparisons.push({kind:'monthly_coverage',raw:baseCoverage.transfer,archived:archiveCoverage.transfer});
            stage='billing';
            const baseBill=await meter.measure(()=>rawTotals(site.id,start,end,site.timezone));
            const bill=await meter.measure(async()=>{
                try{return await reader.getCycleAggregates(site.id,start,end);}catch(error){
                    if(error instanceof Error && error.message==='Incomplete tariff attribution') return null;throw error;
                }
            });
            if(bill.value) {
                compareTotals(baseBill.value,bill.value);comparisons.push({kind:'monthly_bill_inputs',raw:baseBill.transfer,archived:bill.transfer});
                stage='combined request';
                const combined=await meter.measure(()=>reader.getCycleAggregatesAndCoverage(site.id,start,end,site.timezone));
                deepStrictEqual(combined.value.aggregates,bill.value);deepStrictEqual(combined.value.coverage,archiveCoverage.value);
                const separate={bytes:bill.transfer.bytes+archiveCoverage.transfer.bytes,rows:bill.transfer.rows+archiveCoverage.transfer.rows,
                    requests:bill.transfer.requests+archiveCoverage.transfer.requests,selectRequests:bill.transfer.selectRequests+archiveCoverage.transfer.selectRequests};
                combinedCosts.push({separate,combined:combined.transfer});
                stage='partial bill';
                const from=new Date(+start+300000),until=new Date(+end-300000);
                const basePartial=await meter.measure(()=>rawTotals(site.id,from,until,site.timezone));
                const partial=await meter.measure(()=>reader.getCycleAggregates(site.id,from,until));
                compareTotals(basePartial.value,partial.value);partialCosts.push(partial.transfer);
                comparisons.push({kind:'partial_month_bill_inputs',raw:basePartial.transfer,archived:partial.transfer});
            } else incompleteBillWindows++;
            stage='tariff lookup';
            const tariff=await meter.measure(async()=>{
                await pool.query('SELECT id,site_id,name,updated FROM "Tariff" WHERE site_id=$1',[site.id]);
                await pool.query(`SELECT p.*,COALESCE(p.buy_rate,s.buy_rate) AS buy_rate,COALESCE(p.sell_rate,s.sell_rate) AS sell_rate FROM "TariffSchedule" p
                    JOIN "TariffSeason" s ON s.id=p.season_id JOIN "Tariff" t ON t.id=s.tariff_id WHERE t.site_id=$1`,[site.id]);
            });
            tariffCosts.push(tariff.transfer);
        }
        const after=(await pool.query<{count:string}>('SELECT count(*) AS count FROM "EnergyData"')).rows[0].count;
        if(before!==after) throw new Error('Raw row count changed');
        const average=(items:TransferMetrics[]):TransferMetrics=>({bytes:items.reduce((s,x)=>s+x.bytes,0)/items.length,rows:items.reduce((s,x)=>s+x.rows,0)/items.length,
            requests:items.reduce((s,x)=>s+x.requests,0)/items.length,selectRequests:items.reduce((s,x)=>s+x.selectRequests,0)/items.length});
        const groups=[...new Set(comparisons.map(c=>c.kind))].map(kind=>{
            const items=comparisons.filter(c=>c.kind===kind);const raw=average(items.map(c=>c.raw));const archived=average(items.map(c=>c.archived));
            return {kind,windows:items.length,raw,archived,responseReductionPercent:100*(1-archived.bytes/raw.bytes)};
        });
        const report={source:'isolated restore of production energy/tariff backup dated 2026-10-02',sites:sites.length,finalizedDays:finalized,emptyDayWindows:empty,samples,
            rawRowCountPreserved:true,exactChartParity:true,coverageParity:true,billingInputParityTolerance:1e-9,incompleteBillWindows,
            method:'Measured PostgreSQL backend protocol bytes on a private local Unix-socket proxy, warmed connection and serialized operations; no packet/SQL logging',
            groups,combinedBillCoverage:combinedCosts.length?{windows:combinedCosts.length,separate:average(combinedCosts.map(c=>c.separate)),combined:average(combinedCosts.map(c=>c.combined))}:null,
            existingAllVersionTariffLookup:average(tariffCosts),
            limitations:'Local plaintext response bytes exclude TLS/TCP and provider accounting. Includes transaction/control framing. Site/auth/endpoint reads and app-to-browser transfer excluded. Raw bill baseline uses matching local-day groups; not byte-identical to existing UTC-day SQL. Pricing tariff lookup reported separately; no premium/retention policy.'};
        stage='report';writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
    } finally {await pool.end();await meter.close();}
}
run().catch(()=>{console.error(`Local egress measurement failed at ${stage}; source details withheld.`);process.exitCode=1;});
