/** Raw-retaining persistence checkpoint. No cron/default reader/deletion activation. */
import { deepStrictEqual } from 'node:assert';
import { createHash,randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { LatestEnergySnapshot,LatestBatterySoc,CycleAggregateRow,DailyCoverageStat } from '../energy-repo';
import type { EnergyData, Tariff, TariffSchedule, TariffSeason } from '../db-types';
import { addDaysInSiteTimezone, getSiteMidnight,parseSiteLocalDateToMidnight,formatSiteDate } from '../date-utils';
import {recoverVerifiedSamples,rawDayDigest,type RecoveryArchive,type EnergyWrite} from './compact-energy-recovery';
import {validateMaintenanceDates,type MaintenanceSnapshot} from './compact-history-maintenance';
import { auditTariffAttribution } from './compact-tariff-audit';
import { decodeDay, encodeDay, rollupDay, type DayRollup } from './compact-energy';
import {buildLatestMetadata,verifyLatestMetadata,type LatestMetadata,type LatestSample} from './compact-latest-metadata';
import { buildDayMetadata } from './compact-day-metadata';
import type { ScalarHistorySnapshot, AggregateHistorySnapshot, HistorySnapshot, HistorySnapshotStore } from './compact-history-reader';

type RawRecord = { site_id: string; timestamp: Date; tariff_id: number; tariff_schedule_id: number | null;
    load_power: number | string; solar_power: number | string; grid_power: number | string;
    battery_power: number | string; battery_soc: number | string | null };
const columns = 'site_id,timestamp,tariff_id,tariff_schedule_id,load_power,solar_power,grid_power,battery_power,battery_soc';
const raw = (r: RawRecord): EnergyData => ({ ...r, timestamp: new Date(r.timestamp), tariff_id: Number(r.tariff_id),
    tariff_schedule_id: r.tariff_schedule_id === null ? null : Number(r.tariff_schedule_id),
    load_power: Number(r.load_power), solar_power: Number(r.solar_power), grid_power: Number(r.grid_power),
    battery_power: Number(r.battery_power), battery_soc: r.battery_soc === null ? null : Number(r.battery_soc) });
type ArchiveRecord=RecoveryArchive;
type DetailArchiveRecord = Pick<ArchiveRecord, 'site_id'|'day_start'|'day_end'|'revision'|'format_version'|'codec'|'axis'|'checksum'|'payload'|'expected_slots'|'attribution_complete'>;
const detailColumns = 'site_id,day_start,day_end,revision,format_version,codec,axis,checksum,payload,expected_slots,attribution_complete';
type LatestArchiveRecord=Pick<ArchiveRecord,'site_id'|'day_start'|'day_end'|'format_version'|'checksum'|'latest_metadata'|'latest_checksum'>;
const latestColumns='site_id,day_start,day_end,format_version,checksum,latest_metadata,latest_checksum';
const projectedEnergy=(s:LatestSample):LatestEnergySnapshot=>({...s,timestamp:new Date(s.timestamp)});
function verifyLatest(a:LatestArchiveRecord):LatestMetadata {
    if(a.format_version!==1||!a.latest_metadata||!a.latest_checksum)throw new Error('Latest metadata mismatch');
    verifyLatestMetadata(a.latest_metadata,a.latest_checksum,{siteId:a.site_id,start:new Date(a.day_start),end:new Date(a.day_end),archiveChecksum:a.checksum});
    return a.latest_metadata;
}
interface SummaryRecord extends Omit<DayRollup, 'day'> { day_start: Date; revision: string }
function summary(s: SummaryRecord): DayRollup {
    return { site_id:s.site_id, day:new Date(s.day_start), tariff_id:Number(s.tariff_id),
        tariff_schedule_id:s.tariff_schedule_id===null ? null : Number(s.tariff_schedule_id),
        load_power:Number(s.load_power), solar_power:Number(s.solar_power), grid_power:Number(s.grid_power), battery_power:Number(s.battery_power),
        sample_import_wh:Number(s.sample_import_wh), sample_export_wh:Number(s.sample_export_wh),
        sample_charge_wh:Number(s.sample_charge_wh), sample_discharge_wh:Number(s.sample_discharge_wh), sample_count:Number(s.sample_count) };
}
function sameSummaries(expected: DayRollup[], actual: DayRollup[]): boolean {
    const sorted = (rows: DayRollup[]) => [...rows].sort((a,b)=>a.tariff_id-b.tariff_id || (a.tariff_schedule_id??-1)-(b.tariff_schedule_id??-1));
    try { deepStrictEqual(sorted(expected),sorted(actual)); return true; } catch { return false; }
}
export interface ArchiveMutationResult {status:'busy'|'trimmed'|'already-trimmed'|'restored'|'not-pruned';samples:number}
export interface FinalizationResult { status: 'busy' | 'empty' | 'finalized' | 'unchanged'; revision?: string;attributionComplete?:boolean }

export class CompactHistoryStore implements HistorySnapshotStore {
    constructor(private readonly pool: Pool,private readonly transactionTimeoutMs?:number,private readonly mutationGuard?:(client:PoolClient)=>Promise<void>) {
        if(transactionTimeoutMs!==undefined&&(!Number.isInteger(transactionTimeoutMs)||transactionTimeoutMs<1||transactionTimeoutMs>15000))throw new Error('Invalid archive transaction budget');
    }
    private async boundTransaction(client:PoolClient):Promise<void> {
        if(this.transactionTimeoutMs!==undefined) {
            // A transaction timeout terminates the backend. Consume its asynchronous
            // connection error as well as the query rejection; destroy on release.
            client.on('error',()=>undefined);
            await client.query("SELECT set_config('transaction_timeout',$1,true)",[`${this.transactionTimeoutMs}ms`]);
        }
    }

    async readSnapshot(siteId:string,start:Date,end:Date):Promise<HistorySnapshot> {
        return this.snapshot(siteId,start,end,false);
    }

    /** Explicit bounded reconciliation only; normal requests must not transfer both sources. */
    async readVerificationSnapshot(siteId:string,start:Date,end:Date):Promise<HistorySnapshot> {
        return this.snapshot(siteId,start,end,true);
    }

    private async snapshot(siteId: string, start: Date, end: Date, verifyRawOverlap:boolean): Promise<HistorySnapshot> {
        if (!siteId || !Number.isSafeInteger(+start) || !Number.isSafeInteger(+end) || +end - +start > 366 * 86400000) throw new Error('History window invalid or exceeds 366 days');
        if (start >= end) return { raw: [], days: [] };
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query("SET LOCAL statement_timeout = '15s'");
            const archives = await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive"
                WHERE site_id=$1 AND day_start < $3 AND day_end > $2 ORDER BY day_start`, [siteId,start,end]);
            const summaries = await client.query<SummaryRecord>(`SELECT s.* FROM "EnergyDaySummary" s
                JOIN "EnergyDayArchive" a USING (site_id,day_start,revision)
                WHERE a.site_id=$1 AND a.day_start < $3 AND a.day_end > $2
                ORDER BY s.day_start,s.tariff_id,s.tariff_schedule_id NULLS FIRST`, [siteId,start,end]);
            const samples = await client.query<RawRecord>(`SELECT ${columns} FROM "EnergyData"
                WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3
                AND ($4::boolean OR NOT EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id="EnergyData".site_id
                    AND "EnergyData".timestamp >= a.day_start AND "EnergyData".timestamp < a.day_end))
                ORDER BY timestamp LIMIT 105409`, [siteId,start,end,verifyRawOverlap]);
            if (samples.rows.length > 105408) throw new Error('History sample limit exceeded');
            const days = archives.rows.map(a => {
                if (a.format_version !== 1) throw new Error('Unsupported archive version');
                return { siteId: a.site_id, start: new Date(a.day_start), end: new Date(a.day_end), attributionComplete: a.attribution_complete,
                    archive: { codec: a.codec, axis: a.axis, sha256: a.checksum, data: a.payload, expectedSlots: a.expected_slots },
                    summaries: summaries.rows.filter(s=>s.revision===a.revision).map(summary) };
            });
            await client.query('COMMIT');
            return { raw: samples.rows.map(raw), days };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async getLatestEnergyData(siteId:string,asOf=new Date()):Promise<LatestEnergySnapshot|null> {
        if(!siteId||!Number.isSafeInteger(+asOf))throw new Error('Invalid latest energy window');
        const client=await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
            const rawRow=(await client.query<RawRecord>(`SELECT ${columns} FROM "EnergyData" WHERE site_id=$1 AND timestamp<=$2 ORDER BY timestamp DESC LIMIT 1`,[siteId,asOf])).rows[0];
            let result:LatestEnergySnapshot|null=rawRow?{timestamp:new Date(rawRow.timestamp),batterySoc:rawRow.battery_soc===null?null:Number(rawRow.battery_soc),batteryPower:Number(rawRow.battery_power),solarPower:Number(rawRow.solar_power),gridPower:Number(rawRow.grid_power),loadPower:Number(rawRow.load_power)}:null;
            const archives=(await client.query<LatestArchiveRecord>(`SELECT ${latestColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<=$2
                ORDER BY day_start DESC LIMIT 2`,[siteId,asOf])).rows;
            for(const a of archives) {
                let sample:LatestEnergySnapshot|null=null;
                if(a.latest_metadata && verifyLatest(a).sample.timestamp<=+asOf)sample=projectedEnergy(a.latest_metadata.sample);
                else {
                    const detail=(await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2`,[siteId,a.day_start])).rows[0];
                    if(detail.format_version!==1)throw new Error('Unsupported archive version');
                    const rows=decodeDay({codec:detail.codec,axis:detail.axis,sha256:detail.checksum,data:detail.payload,expectedSlots:detail.expected_slots},{siteId,start:new Date(detail.day_start),end:new Date(detail.day_end)});
                    const row=rows.findLast(r=>r.timestamp<=asOf);
                    if(row)sample={timestamp:row.timestamp,batterySoc:row.battery_soc??null,batteryPower:row.battery_power,solarPower:row.solar_power,gridPower:row.grid_power,loadPower:row.load_power};
                }
                if(sample){if(!result||sample.timestamp>result.timestamp)result=sample;break;}
            }
            await client.query('COMMIT');return result;
        } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }

    async getLatestBatterySoc(siteId:string,since:Date):Promise<LatestBatterySoc|null> {
        const now=new Date();
        if(!siteId||!Number.isSafeInteger(+since)||+now-+since>366*86400000)throw new Error('Invalid SOC window or exceeds 366 days');
        if(since>now)return null;
        const client=await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
            const rawRow=(await client.query<{timestamp:Date;battery_soc:number}>(`SELECT timestamp,battery_soc FROM "EnergyData" WHERE site_id=$1 AND timestamp>=$2 AND timestamp<=$3 AND battery_soc IS NOT NULL ORDER BY timestamp DESC LIMIT 1`,[siteId,since,now])).rows[0];
            const guard=(await client.query<{verified:boolean;legacy:boolean}>(`SELECT COALESCE(bool_and(CASE WHEN latest_metadata IS NOT NULL THEN public.verify_compact_latest_metadata(site_id,day_start) ELSE true END),true) AS verified,
                COALESCE(bool_or(latest_metadata IS NULL),false) AS legacy FROM "EnergyDayArchive" WHERE site_id=$1 AND day_end>$2 AND day_start<=$3`,[siteId,since,now])).rows[0];
            if(!guard.verified)throw new Error('Latest metadata mismatch');
            if(guard.legacy)throw new Error('Latest SOC metadata requires rebuild');
            const archive=(await client.query<LatestArchiveRecord>(`SELECT ${latestColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND latest_metadata IS NOT NULL
                AND (latest_metadata->'soc'->>'timestamp')::bigint >= $2 AND (latest_metadata->'soc'->>'timestamp')::bigint <= $3
                ORDER BY (latest_metadata->'soc'->>'timestamp')::bigint DESC LIMIT 1`,[siteId,+since,+now])).rows[0];
            let result:LatestBatterySoc|null=rawRow?{timestamp:new Date(rawRow.timestamp),value:Number(rawRow.battery_soc)}:null;
            if(archive) {
                const charge=verifyLatest(archive).soc;
                if(charge && (!result||charge.timestamp>+result.timestamp))result={timestamp:new Date(charge.timestamp),value:charge.value};
            }
            await client.query('COMMIT');return result;
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }

    /** Scalar modern freshness; only legacy metadata needs the selected day's payload. */
    async getLatestTimestamp(siteId:string):Promise<Date|null> {
        if(!siteId) throw new Error('Invalid site');
        const client=await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query("SET LOCAL statement_timeout='15s'");
            const rawLatest=(await client.query<{timestamp:Date}>(`SELECT timestamp FROM "EnergyData"
                WHERE site_id=$1 AND timestamp<=CURRENT_TIMESTAMP ORDER BY timestamp DESC LIMIT 1`,[siteId])).rows[0]?.timestamp;
            const archive=(await client.query<{day_start:Date;day_end:Date;last_timestamp:Date|null;modern:boolean;verified:boolean}>(`SELECT day_start,day_end,last_timestamp,
                (metadata_version=2 AND metadata_checksum IS NOT NULL) AS modern,
                CASE WHEN metadata_version=2 AND metadata_checksum IS NOT NULL
                    THEN public.verify_compact_day_metadata(site_id,day_start,false) ELSE true END AS verified
                FROM "EnergyDayArchive" WHERE site_id=$1 AND day_end<=CURRENT_TIMESTAMP ORDER BY day_start DESC LIMIT 1`,[siteId])).rows[0];
            let archivedLatest:Date|null=null;
            if(archive) {
                if(!archive.verified) throw new Error('Day metadata mismatch');
                if(archive.modern) archivedLatest=archive.last_timestamp?new Date(archive.last_timestamp):null;
                else {
                    const a=(await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive"
                        WHERE site_id=$1 AND day_start=$2`,[siteId,archive.day_start])).rows[0];
                    if(a.format_version!==1) throw new Error('Unsupported archive version');
                    const samples=decodeDay({codec:a.codec,axis:a.axis,sha256:a.checksum,data:a.payload,expectedSlots:a.expected_slots},
                        {siteId,start:new Date(a.day_start),end:new Date(a.day_end)});
                    archivedLatest=samples.at(-1)?.timestamp??null;
                }
            }
            const candidates=[rawLatest?new Date(rawLatest):null,archivedLatest].filter((d):d is Date=>d!==null);
            await client.query('COMMIT');
            return candidates.length?new Date(Math.max(...candidates.map(Number))):null;
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    }

    private async claimMutation(client:PoolClient,siteId:string):Promise<boolean> {
        const global=await client.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('compact-energy-maintenance',0)) AS acquired");
        if(!global.rows[0].acquired)return false;
        return (await client.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended('compact-energy:'||$1::text,0)) AS acquired",[siteId])).rows[0].acquired;
    }

    private async recoverySamples(client:PoolClient,archive:ArchiveRecord):Promise<EnergyData[]> {
        const summaries=(await client.query<SummaryRecord>('SELECT * FROM "EnergyDaySummary" WHERE site_id=$1 AND day_start=$2 AND revision=$3 FOR UPDATE',
            [archive.site_id,archive.day_start,archive.revision])).rows.map(summary);
        return recoverVerifiedSamples(archive,summaries);
    }

    private async reviewedMutation(siteId:string,start:Date,revision:string,action:(client:PoolClient,archive:ArchiveRecord)=>Promise<ArchiveMutationResult>):Promise<ArchiveMutationResult> {
        if(!siteId?.trim()||siteId.length>200||!Number.isSafeInteger(+start)||!revision||!/^[-0-9a-f]{36}$/.test(revision))throw new Error('Invalid reviewed revision');
        const client=await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            await this.boundTransaction(client);
            await client.query("SET LOCAL statement_timeout='15s'");await client.query("SET LOCAL lock_timeout='3s'");
            await this.mutationGuard?.(client);
            if(!await this.claimMutation(client,siteId)) {await client.query('ROLLBACK');return {status:'busy',samples:0};}
            const archive=(await client.query<ArchiveRecord>('SELECT * FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2 FOR UPDATE',[siteId,start])).rows[0];
            if(!archive||archive.revision!==revision)throw new Error('Reviewed archive revision changed or is missing');
            const result=await action(client,archive);await client.query('COMMIT');return result;
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release(this.transactionTimeoutMs!==undefined);}
    }

    /** Not exposed by any CLI/route. Requires explicit reviewed revision; production approval is a separate gate. */
    async trimDay(siteId:string,start:Date,revision:string,now=new Date()):Promise<ArchiveMutationResult> {
        if(!Number.isSafeInteger(+now))throw new Error('Invalid trim clock');
        return this.reviewedMutation(siteId,start,revision,async(client,archive)=>{
            const site=(await client.query<{timezone:string}>('SELECT timezone FROM "Site" WHERE id=$1',[siteId])).rows[0];
            if(!site?.timezone)throw new Error('Invalid site timezone');
            new Intl.DateTimeFormat('en-US',{timeZone:site.timezone});
            if(+start!==+getSiteMidnight(start,site.timezone)||+archive.day_end!==+addDaysInSiteTimezone(start,1,site.timezone))throw new Error('Invalid local archive bounds');
            if(archive.day_end>addDaysInSiteTimezone(getSiteMidnight(now,site.timezone),-2,site.timezone))throw new Error('Cannot trim recent days');
            if(!archive.attribution_complete)throw new Error('Incomplete tariff attribution');
            const recovered=await this.recoverySamples(client,archive);
            const source=(await client.query<{digest:string;samples:number}>('SELECT * FROM public.compact_raw_day_digest($1,$2,$3)',[siteId,start,archive.day_end])).rows[0];
            if(archive.raw_pruned) {
                if(source.samples)throw new Error('Unexpected raw samples in pruned day');
                return {status:'already-trimmed',samples:0};
            }
            if(source.samples!==recovered.length||source.digest!==rawDayDigest(recovered,siteId,start,archive.day_end))throw new Error('Raw archive reconciliation failed');
            await client.query('UPDATE "EnergyDayArchive" SET raw_pruned=true WHERE site_id=$1 AND day_start=$2 AND revision=$3',[siteId,start,revision]);
            const deleted=await client.query('DELETE FROM "EnergyData" WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3',[siteId,start,archive.day_end]);
            if(deleted.rowCount!==recovered.length)throw new Error('Trim row count mismatch');
            return {status:'trimmed',samples:deleted.rowCount};
        });
    }

    private async insertRows(client:PoolClient,rows:EnergyWrite[]):Promise<void> {
        const number=(value:number|null)=>typeof value==='number'&&Object.is(value,-0)?'-0':value;
        for(let offset=0;offset<rows.length;offset+=512) {
            const params:unknown[]=[];
            const values=rows.slice(offset,offset+512).map(row=>{
                const first=params.length+1;
                params.push(row.site_id,row.timestamp,row.tariff_id,row.tariff_schedule_id??null,
                    ...[row.load_power,row.solar_power,row.grid_power,row.battery_power,row.battery_soc].map(number));
                return `(${Array.from({length:9},(_,i)=>'$'+(first+i)).join(',')})`;
            });
            await client.query(`INSERT INTO "EnergyData" (${columns}) VALUES ${values.join(',')}
                ON CONFLICT(timestamp,site_id) DO UPDATE SET tariff_id=EXCLUDED.tariff_id,tariff_schedule_id=EXCLUDED.tariff_schedule_id,
                load_power=EXCLUDED.load_power,solar_power=EXCLUDED.solar_power,grid_power=EXCLUDED.grid_power,battery_power=EXCLUDED.battery_power,
                battery_soc=COALESCE(EXCLUDED.battery_soc,"EnergyData".battery_soc)`,params);
        }
    }

    private async restoreOnClient(client:PoolClient,archive:ArchiveRecord):Promise<number> {
        const rows=await this.recoverySamples(client,archive);
        const collision=(await client.query<{present:boolean}>('SELECT EXISTS(SELECT 1 FROM "EnergyData" WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3) AS present',
            [archive.site_id,archive.day_start,archive.day_end])).rows[0].present;
        if(collision)throw new Error('Unexpected raw samples in pruned day');
        await client.query('DELETE FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2 AND revision=$3',[archive.site_id,archive.day_start,archive.revision]);
        await this.insertRows(client,rows);
        const restored=(await client.query<{digest:string;samples:number}>('SELECT * FROM public.compact_raw_day_digest($1,$2,$3)',
            [archive.site_id,archive.day_start,archive.day_end])).rows[0];
        if(restored.samples!==rows.length||restored.digest!==rawDayDigest(rows,archive.site_id,archive.day_start,archive.day_end))throw new Error('Restoration reconciliation failed');
        return rows.length;
    }

    async restoreDay(siteId:string,start:Date,revision:string):Promise<ArchiveMutationResult> {
        return this.reviewedMutation(siteId,start,revision,async(client,archive)=>archive.raw_pruned?
            {status:'restored',samples:await this.restoreOnClient(client,archive)}:{status:'not-pruned',samples:0});
    }

    /** Restores full touched days before partial imports; all recovery and incoming writes commit together. */
    async writeEnergyDataBatch(rows:EnergyWrite[]):Promise<void> {
        if(!rows.length)return;
        const sites=[...new Set(rows.map(r=>r.site_id))].sort();const keys=new Set<string>();
        if(rows.length>4096||sites.length>7||rows.some(r=>{
            const key=JSON.stringify([r.site_id,+r.timestamp]);const duplicate=keys.has(key);keys.add(key);
            return duplicate||!r.site_id?.trim()||r.site_id.length>200||!Number.isSafeInteger(+r.timestamp)||!Number.isSafeInteger(r.tariff_id)
                ||(r.tariff_schedule_id!=null&&!Number.isSafeInteger(r.tariff_schedule_id))
                ||[r.load_power,r.solar_power,r.grid_power,r.battery_power].some(v=>!Number.isFinite(v))||(r.battery_soc!==null&&!Number.isFinite(r.battery_soc));
        }))throw new Error('Invalid or oversized energy write batch');
        const times=rows.map(r=>+r.timestamp),first=new Date(Math.min(...times)),last=new Date(Math.max(...times));
        if(+last-+first>7*27*3600000)throw new Error('Energy batch range exceeds seven days');
        const client=await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            await client.query("SET LOCAL statement_timeout='15s'");await client.query("SET LOCAL lock_timeout='3s'");
            for(const site of sites)if(!await this.claimMutation(client,site))throw new Error('Energy mutation claim busy');
            const candidates=(await client.query<{site_id:string;day_start:Date}>(`SELECT a.site_id,a.day_start FROM "EnergyDayArchive" a WHERE raw_pruned AND a.site_id=ANY($3::text[]) AND a.day_start<=$5 AND a.day_end>$4 AND
                EXISTS(SELECT 1 FROM unnest($1::text[],$2::timestamptz[]) t(site_id,timestamp) WHERE t.site_id=a.site_id AND t.timestamp>=a.day_start AND t.timestamp<a.day_end)
                ORDER BY a.site_id,a.day_start LIMIT 8`,[rows.map(r=>r.site_id),rows.map(r=>r.timestamp),sites,first,last])).rows;
            if(candidates.length>7)throw new Error('Energy batch restoration exceeds seven days');
            for(const candidate of candidates) {
                const archive=(await client.query<ArchiveRecord>('SELECT * FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2 FOR UPDATE',[candidate.site_id,candidate.day_start])).rows[0];
                if(!archive?.raw_pruned)throw new Error('Recovery archive changed');
                await this.restoreOnClient(client,archive);
            }
            await this.insertRows(client,rows);await client.query('COMMIT');
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    }

    /** Bounded operator preview: only scalar coverage/integrity leaves the database. */
    async getMaintenanceSnapshot(siteId:string,from:string,before:string,rebuild:boolean,now:Date):Promise<MaintenanceSnapshot> {
        validateMaintenanceDates(from,before);
        if(!siteId?.trim()||siteId.length>200||!Number.isSafeInteger(+now))throw new Error('Invalid maintenance request');
        const client=await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query("SET LOCAL statement_timeout='15s'");
            const site=(await client.query<{timezone:string}>('SELECT timezone FROM "Site" WHERE id=$1',[siteId])).rows[0];
            if(!site)throw new Error('Site not found');
            // Unlike display helpers, maintenance must fail rather than silently fall back to UTC.
            if(!site.timezone)throw new Error('Invalid site timezone');
            new Intl.DateTimeFormat('en-US',{timeZone:site.timezone});
            const start=parseSiteLocalDateToMidnight(from,site.timezone),end=parseSiteLocalDateToMidnight(before,site.timezone);
            let cursor=start,days=0;
            while(cursor<end&&days<=31) {cursor=addDaysInSiteTimezone(cursor,1,site.timezone);days++;}
            if(days>31||+cursor!==+end)throw new Error('Maintenance range exceeds 31 local days');
            if(end>addDaysInSiteTimezone(getSiteMidnight(now,site.timezone),-2,site.timezone))throw new Error('Maintenance must retain two recent completed days');
            if(rebuild && (await client.query<{present:boolean}>('SELECT EXISTS(SELECT 1 FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start >= $2 AND day_end <= $3 AND raw_pruned) AS present',[siteId,start,end])).rows[0].present)
                throw new Error('Restore pruned days before rebuilding');
            const result=await client.query<{key:string;count:number;first:Date;last:Date;gap:string}>(`WITH bounded AS MATERIALIZED (
                SELECT timestamp FROM "EnergyData" WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3 ORDER BY timestamp LIMIT 126977
            ), samples AS (
                SELECT timestamp,date_trunc('day',timestamp AT TIME ZONE $4::text) AS day,
                lag(timestamp) OVER (PARTITION BY date_trunc('day',timestamp AT TIME ZONE $4::text) ORDER BY timestamp) AS previous FROM bounded
            ) SELECT to_char(day,'YYYY-MM-DD') AS key,count(*)::int AS count,min(timestamp) AS first,max(timestamp) AS last,
                COALESCE(max(EXTRACT(EPOCH FROM (timestamp-previous))*1000),0) AS gap FROM samples GROUP BY day ORDER BY day`,[siteId,start,end,site.timezone]);
            if(result.rows.reduce((sum,r)=>sum+r.count,0)>126976)throw new Error('Maintenance sample limit exceeded');
            const archives=rebuild?[]:(await client.query<{start:Date;attribution_complete:boolean;verified:boolean;modern:boolean;raw_pruned:boolean;sample_count:number;first_timestamp:Date;last_timestamp:Date;max_interior_gap_ms:number}>(`SELECT day_start AS start,attribution_complete,raw_pruned,sample_count,first_timestamp,last_timestamp,max_interior_gap_ms,
                format_version=1 AND CASE WHEN payload_checksum IS NOT NULL THEN payload_checksum=encode(sha256(payload),'hex') ELSE true END AND CASE WHEN metadata_version=2 AND metadata_checksum IS NOT NULL
                    THEN public.verify_compact_day_metadata(site_id,day_start,false) ELSE true END
                    AND CASE WHEN latest_metadata IS NOT NULL THEN public.verify_compact_latest_metadata(site_id,day_start) ELSE true END AS verified,
                metadata_version=2 AND metadata_checksum IS NOT NULL AND latest_metadata IS NOT NULL AND payload_checksum IS NOT NULL AS modern
                FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start >= $2 AND day_end <= $3 ORDER BY day_start`,[siteId,start,end])).rows;
            if(archives.some(a=>!a.verified))throw new Error('Archive integrity mismatch');
            const coverage:DailyCoverageStat[]=result.rows.map(r=>({localDayKey:r.key,count:r.count,first:new Date(r.first),last:new Date(r.last),maxInteriorGapMs:Number(r.gap)}));
            for(const archive of archives.filter(a=>a.raw_pruned)) {
                if(!archive.modern)throw new Error('Pruned archive metadata requires recovery');
                const key=formatSiteDate(archive.start,site.timezone);
                if(coverage.some(r=>r.localDayKey===key))throw new Error('Unexpected raw samples in pruned day');
                coverage.push({localDayKey:key,count:archive.sample_count,first:new Date(archive.first_timestamp),last:new Date(archive.last_timestamp),maxInteriorGapMs:archive.max_interior_gap_ms});
            }
            coverage.sort((a,b)=>a.localDayKey.localeCompare(b.localDayKey));
            await client.query('COMMIT');
            return {timezone:site.timezone,start,end,coverage,
                archives:archives.filter(a=>a.modern).map(a=>({start:new Date(a.start),attributionComplete:a.attribution_complete,...(a.raw_pruned?{rawPruned:true}:{})}))};
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    }

    /** Transitional legacy cleanup: exclusive maintenance claim precedes the archive check and both deletions. */
    async cleanupLegacyHistory(cutoff:Date):Promise<{skipped:true}|{skipped:false;energyDeleted:number;tagsDeleted:number}> {
        if(!Number.isSafeInteger(+cutoff))throw new Error('Invalid cleanup cutoff');
        const client=await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            await client.query("SET LOCAL statement_timeout='15s'");
            const claim=await client.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended('compact-energy-maintenance',0)) AS acquired");
            if(!claim.rows[0].acquired) {await client.query('ROLLBACK');return {skipped:true};}
            const archives=await client.query<{present:boolean}>('SELECT EXISTS(SELECT 1 FROM "EnergyDayArchive") AS present');
            if(archives.rows[0].present) {await client.query('ROLLBACK');return {skipped:true};}
            const energy=await client.query('DELETE FROM "EnergyData" WHERE timestamp < $1',[cutoff]);
            const tags=await client.query('DELETE FROM "LoadTag" WHERE end_time < $1',[cutoff]);
            await client.query('COMMIT');
            return {skipped:false,energyDeleted:energy.rowCount??0,tagsDeleted:tags.rowCount??0};
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    }

    async hasAnyArchives():Promise<boolean> {
        return (await this.pool.query<{present:boolean}>('SELECT EXISTS(SELECT 1 FROM "EnergyDayArchive") AS present')).rows[0].present;
    }

    async hasData(siteId:string):Promise<boolean> {
        const result=await this.pool.query<{present:boolean}>(`SELECT EXISTS (SELECT 1 FROM "EnergyData" WHERE site_id=$1)
            OR EXISTS (SELECT 1 FROM "EnergyDayArchive" WHERE site_id=$1) AS present`,[siteId]);
        return result.rows[0].present;
    }

    async readAggregateSnapshot(siteId:string,start:Date,end:Date):Promise<AggregateHistorySnapshot> {
        if (!siteId || !Number.isSafeInteger(+start) || !Number.isSafeInteger(+end) || +end-+start>366*86400000) throw new Error('History window invalid or exceeds 366 days');
        if (start>=end) return {timezone:null,fullDays:[],detail:{raw:[],days:[]}};
        const client=await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query("SET LOCAL statement_timeout='15s'");
            const site=await client.query<{timezone:string}>('SELECT timezone FROM "Site" WHERE id=$1',[siteId]);
            // Deliberately omit payload: complete modern days require only scalar metadata.
            const full=await client.query<Omit<ArchiveRecord,'payload'>>(`SELECT site_id,day_start,day_end,revision,format_version,codec,axis,checksum,
                expected_slots,sample_count,attribution_complete,first_timestamp,last_timestamp,max_interior_gap_ms,metadata_checksum,metadata_version
                FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start >= $2 AND day_end <= $3 AND metadata_checksum IS NOT NULL ORDER BY day_start`,[siteId,start,end]);
            const partial=await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<$3 AND day_end>$2
                AND NOT (day_start >= $2 AND day_end <= $3 AND metadata_checksum IS NOT NULL) ORDER BY day_start`,[siteId,start,end]);
            const summaries=(await client.query<SummaryRecord>(`SELECT s.* FROM "EnergyDaySummary" s JOIN "EnergyDayArchive" a USING (site_id,day_start,revision)
                WHERE a.site_id=$1 AND a.day_start<$3 AND a.day_end>$2 ORDER BY s.day_start,s.tariff_id,s.tariff_schedule_id NULLS FIRST`,[siteId,start,end])).rows;
            const samples=await client.query<RawRecord>(`SELECT ${columns} FROM "EnergyData" e WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3
                AND NOT EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=e.site_id AND e.timestamp >= a.day_start AND e.timestamp < a.day_end)
                ORDER BY timestamp LIMIT 105409`,[siteId,start,end]);
            if (samples.rows.length>105408) throw new Error('History sample limit exceeded');
            const parts=partial.rows.map(a=>({siteId:a.site_id,start:new Date(a.day_start),end:new Date(a.day_end),attributionComplete:a.attribution_complete,
                archive:{codec:a.codec,axis:a.axis,sha256:a.checksum,data:a.payload,expectedSlots:a.expected_slots},
                summaries:summaries.filter(s=>s.revision===a.revision).map(summary)}));
            const fullDays=full.rows.map(a=>({siteId:a.site_id,start:new Date(a.day_start),end:new Date(a.day_end),attributionComplete:a.attribution_complete,
                sampleCount:a.sample_count,first:new Date(a.first_timestamp??NaN),last:new Date(a.last_timestamp??NaN),
                maxInteriorGapMs:a.max_interior_gap_ms??NaN,checksum:a.metadata_checksum??'',checksumVersion:a.metadata_version,summaries:summaries.filter(s=>s.revision===a.revision).map(summary)}));
            if ([...full.rows,...partial.rows].some(a=>a.format_version!==1)) throw new Error('Unsupported archive version');
            await client.query('COMMIT');
            return {timezone:site.rows[0]?.timezone??null,fullDays,detail:{raw:samples.rows.map(raw),days:parts}};
        } catch (error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
    }

    async readScalarSnapshot(siteId:string,start:Date,end:Date,mode:{billing:boolean;coverage:boolean}):Promise<ScalarHistorySnapshot> {
        if(!siteId || !Number.isSafeInteger(+start)||!Number.isSafeInteger(+end)||+end-+start>366*86400000) throw new Error('History window invalid or exceeds 366 days');
        if(start>=end) return {timezone:null,aggregates:[],coverage:[],detail:{raw:[],days:[]}};
        const client=await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
            const site=await client.query<{timezone:string;has_detail:boolean;has_raw:boolean;verified:boolean;attribution_complete:boolean}>(`SELECT timezone,
                EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start<$3 AND a.day_end>$2
                    AND NOT(a.day_start >= $2 AND a.day_end <= $3 AND a.metadata_version=2 AND a.metadata_checksum IS NOT NULL)) AS has_detail,
                EXISTS (SELECT 1 FROM "EnergyData" e WHERE e.site_id=$1 AND e.timestamp >= $2 AND e.timestamp < $3
                    AND NOT EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=e.site_id AND e.timestamp>=a.day_start AND e.timestamp<a.day_end)) AS has_raw,
                COALESCE((SELECT bool_and(public.verify_compact_day_metadata(a.site_id,a.day_start,false))
                    FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start >= $2 AND a.day_end <= $3
                    AND a.metadata_version=2 AND a.metadata_checksum IS NOT NULL),true) AS verified,
                COALESCE((SELECT bool_and(a.attribution_complete AND NOT EXISTS (
                    SELECT 1 FROM "EnergyDaySummary" s WHERE s.site_id=a.site_id AND s.day_start=a.day_start AND s.revision=a.revision AND s.tariff_schedule_id IS NULL
                )) FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start >= $2 AND a.day_end <= $3
                    AND a.metadata_version=2 AND a.metadata_checksum IS NOT NULL),true) AS attribution_complete
                FROM "Site" WHERE id=$1`,[siteId,start,end]);
            if(site.rows[0] && !site.rows[0].verified) throw new Error('Day metadata mismatch');
            const timezone=site.rows[0]?.timezone??null;
            const aggregates:CycleAggregateRow[]=[];const coverage:DailyCoverageStat[]=[];
            const eligible=`SELECT a.site_id,a.day_start,a.revision,a.first_timestamp,a.last_timestamp,a.sample_count,a.max_interior_gap_ms
                FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start >= $2 AND a.day_end <= $3
                AND a.metadata_version=2 AND a.metadata_checksum IS NOT NULL`;
            if(mode.billing) {
                const result=await client.query<CycleAggregateRow>(`WITH eligible AS MATERIALIZED (${eligible})
                    SELECT s.day_start AS day,s.tariff_id,s.tariff_schedule_id,s.load_power,s.solar_power,s.grid_power,s.battery_power
                    FROM "EnergyDaySummary" s JOIN eligible a USING(site_id,day_start,revision) ORDER BY day,tariff_id,tariff_schedule_id`,[siteId,start,end]);
                aggregates.push(...result.rows.map(r=>({...r,day:new Date(r.day),tariff_id:Number(r.tariff_id),tariff_schedule_id:r.tariff_schedule_id===null?null:Number(r.tariff_schedule_id),
                    load_power:Number(r.load_power),solar_power:Number(r.solar_power),grid_power:Number(r.grid_power),battery_power:Number(r.battery_power)})));
            }
            if(mode.coverage && timezone) {
                const result=await client.query<{key:string;count:number;first:Date;last:Date;gap:number}>(`WITH eligible AS MATERIALIZED (${eligible})
                    SELECT to_char(day_start AT TIME ZONE $4::text,'YYYY-MM-DD') AS key,sample_count AS count,
                        first_timestamp AS first,last_timestamp AS last,max_interior_gap_ms AS gap FROM eligible ORDER BY day_start`,[siteId,start,end,timezone]);
                coverage.push(...result.rows.map(r=>({localDayKey:r.key,count:r.count,first:new Date(r.first),last:new Date(r.last),maxInteriorGapMs:r.gap})));
            }
            const partial=site.rows[0]?.has_detail?await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<$3 AND day_end>$2
                AND NOT (day_start >= $2 AND day_end <= $3 AND metadata_version=2 AND metadata_checksum IS NOT NULL) ORDER BY day_start`,[siteId,start,end]):{rows:[]};
            const summaries=partial.rows.length?(await client.query<SummaryRecord>(`SELECT s.* FROM "EnergyDaySummary" s JOIN "EnergyDayArchive" a USING(site_id,day_start,revision)
                WHERE a.site_id=$1 AND a.day_start<$3 AND a.day_end>$2 AND NOT (a.day_start >= $2 AND a.day_end <= $3 AND a.metadata_version=2 AND a.metadata_checksum IS NOT NULL)
                ORDER BY s.day_start,s.tariff_id,s.tariff_schedule_id NULLS FIRST`,[siteId,start,end])).rows:[];
            const rawRows=site.rows[0]?.has_raw?await client.query<RawRecord>(`SELECT ${columns} FROM "EnergyData" e WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3
                AND NOT EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=e.site_id AND e.timestamp>=a.day_start AND e.timestamp<a.day_end)
                ORDER BY timestamp LIMIT 105409`,[siteId,start,end]):{rows:[]};
            if(rawRows.rows.length>105408) throw new Error('History sample limit exceeded');
            const days=partial.rows.map(a=>({siteId:a.site_id,start:new Date(a.day_start),end:new Date(a.day_end),attributionComplete:a.attribution_complete,
                archive:{codec:a.codec,axis:a.axis,sha256:a.checksum,data:a.payload,expectedSlots:a.expected_slots},summaries:summaries.filter(s=>s.revision===a.revision).map(summary)}));
            if(partial.rows.some(a=>a.format_version!==1)) throw new Error('Unsupported archive version');
            await client.query('COMMIT');return {attributionComplete:site.rows[0]?.attribution_complete??true,timezone,aggregates,coverage,detail:{raw:rawRows.rows.map(raw),days}};
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    }

    async finalizeDay(siteId: string, start: Date, now = new Date()): Promise<FinalizationResult> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            await this.boundTransaction(client);
            await client.query("SET LOCAL statement_timeout = '15s'");
            await client.query("SET LOCAL lock_timeout = '3s'");
            await this.mutationGuard?.(client);
            // Shared global claim first: cleanup cannot pass its empty-table guard during first finalization.
            const maintenance = await client.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('compact-energy-maintenance',0)) AS acquired");
            if(!maintenance.rows[0].acquired) {await client.query('ROLLBACK');return {status:'busy'};}
            const claim = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('compact-energy:' || $1::text,0)) AS acquired",[siteId]);
            if (!claim.rows[0].acquired) { await client.query('ROLLBACK'); return { status:'busy' }; }
            const site = await client.query<{ timezone: string }>('SELECT timezone FROM "Site" WHERE id=$1',[siteId]);
            const timezone = site.rows[0]?.timezone;
            if (!timezone || !Number.isSafeInteger(+start) || !Number.isSafeInteger(+now)
                || +start !== +getSiteMidnight(start,timezone)) throw new Error('Expected a completed local day');
            const end = addDaysInSiteTimezone(start,1,timezone);
            if (end > getSiteMidnight(now,timezone)) throw new Error('Expected a completed local day');
            const existing = await client.query<ArchiveRecord>('SELECT * FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2 FOR UPDATE',[siteId,start]);
            const old = existing.rows[0];
            if(old?.raw_pruned) {
                if(+old.day_end!==+end)throw new Error('Pruned archive day bounds mismatch');
                await this.recoverySamples(client,old);
                const collision=(await client.query<{present:boolean}>('SELECT EXISTS(SELECT 1 FROM "EnergyData" WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3) AS present',[siteId,start,end])).rows[0].present;
                if(collision)throw new Error('Unexpected raw samples in pruned day');
                await client.query('COMMIT');return {status:'unchanged',revision:old.revision,attributionComplete:old.attribution_complete};
            }
            const input = await client.query<RawRecord>(`SELECT ${columns} FROM "EnergyData"
                WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3 ORDER BY timestamp LIMIT 4097`,[siteId,start,end]);
            const rows = input.rows.map(raw);
            if(old && rows.length!==old.sample_count)throw new Error('Raw archive source incomplete; restore before rebuilding');
            if (!rows.length) { await client.query('COMMIT'); return { status:'empty' }; }
            const archive = encodeDay(rows,start,end,'brotli');
            const recovered = decodeDay(archive,{siteId,start,end});
            deepStrictEqual(recovered, rows);
            const summaries = rollupDay(recovered,start);
            const reference = rollupDay(rows,start);
            if (JSON.stringify(summaries)!==JSON.stringify(reference)) throw new Error('Finalization reconciliation failed');
            const { tariffs, schedules } = await this.tariffs(client,siteId);
            const audit = auditTariffAttribution(rows,timezone,tariffs,schedules);
            // Null inference is reported but never silently rewrites the lossless source IDs.
            const attributionComplete = audit.unresolvedSamples===0 && audit.inferredSamples===0 && audit.recordedPeriodDisagreements===0
                && audit.periods.every(p=>Number.isFinite(p.buy_rate)&&Number.isFinite(p.sell_rate));
            const metadata=buildDayMetadata(recovered,start,end,attributionComplete);
            const payloadChecksum=createHash('sha256').update(archive.data).digest('hex');
            const latest=buildLatestMetadata(recovered,{siteId,start,end,archiveChecksum:archive.sha256});
            let oldLatestValid=false;
            if(old) {try {verifyLatest(old);oldLatestValid=true;}catch { /* Retry repairs stale/missing projections. */ }}
            const previousSummaries = old ? (await client.query<SummaryRecord>(
                'SELECT * FROM "EnergyDaySummary" WHERE site_id=$1 AND day_start=$2 AND revision=$3', [siteId,start,old.revision])).rows.map(summary) : [];
            if (old && old.payload_checksum===payloadChecksum && oldLatestValid && old.latest_checksum===latest.checksum && old.checksum===archive.sha256 && old.attribution_complete===attributionComplete
                && old.payload.equals(archive.data) && old.codec===archive.codec && old.axis===archive.axis
                && old.format_version===1 && +old.day_end===+end && old.sample_count===rows.length
                && old.expected_slots===archive.expectedSlots && old.metadata_version===2 && old.metadata_checksum===metadata.checksum
                && +(old.first_timestamp??NaN)===+metadata.first && +(old.last_timestamp??NaN)===+metadata.last
                && old.max_interior_gap_ms===metadata.maxInteriorGapMs && sameSummaries(summaries,previousSummaries)) {
                await client.query('COMMIT'); return { status:'unchanged', revision:old.revision,attributionComplete };
            }
            const revision = randomUUID();
            await client.query('DELETE FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[siteId,start]);
            await client.query(`INSERT INTO "EnergyDayArchive" (site_id,day_start,day_end,revision,format_version,codec,axis,checksum,payload,sample_count,expected_slots,attribution_complete,first_timestamp,last_timestamp,max_interior_gap_ms,metadata_checksum,metadata_version,latest_metadata,latest_checksum,payload_checksum)
                VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,2,$16,$17,$18)`,[siteId,start,end,revision,archive.codec,archive.axis,archive.sha256,archive.data,rows.length,archive.expectedSlots,attributionComplete,metadata.first,metadata.last,metadata.maxInteriorGapMs,metadata.checksum,JSON.stringify(latest.data),latest.checksum,payloadChecksum]);
            for (const s of summaries) await client.query(`INSERT INTO "EnergyDaySummary" (site_id,day_start,revision,tariff_id,tariff_schedule_id,
                load_power,solar_power,grid_power,battery_power,sample_import_wh,sample_export_wh,sample_charge_wh,sample_discharge_wh,sample_count)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[siteId,start,revision,s.tariff_id,s.tariff_schedule_id,
                s.load_power,s.solar_power,s.grid_power,s.battery_power,s.sample_import_wh,s.sample_export_wh,s.sample_charge_wh,s.sample_discharge_wh,s.sample_count]);
            await client.query('COMMIT');
            return { status:'finalized', revision,attributionComplete };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(this.transactionTimeoutMs!==undefined); }
    }

    private async tariffs(client: PoolClient,siteId: string): Promise<{ tariffs:Tariff[]; schedules:TariffSchedule[] }> {
        const tariffs = (await client.query<Tariff>('SELECT * FROM "Tariff" WHERE site_id=$1',[siteId])).rows;
        const seasons = (await client.query<TariffSeason>(`SELECT s.* FROM "TariffSeason" s JOIN "Tariff" t ON t.id=s.tariff_id WHERE t.site_id=$1`,[siteId])).rows;
        const schedules = (await client.query<TariffSchedule>(`SELECT p.* FROM "TariffSchedule" p JOIN "TariffSeason" s ON s.id=p.season_id
            JOIN "Tariff" t ON t.id=s.tariff_id WHERE t.site_id=$1`,[siteId])).rows;
        for (const tariff of tariffs) tariff.seasons = seasons.filter(s=>s.tariff_id===tariff.id).map(s=>({ ...s,
            buy_rate:Number(s.buy_rate), sell_rate:Number(s.sell_rate), schedules:schedules.filter(p=>p.season_id===s.id).map(p=>({ ...p,
                buy_rate:p.buy_rate===null ? null : Number(p.buy_rate), sell_rate:p.sell_rate===null ? null : Number(p.sell_rate) })) }));
        return { tariffs, schedules:tariffs.flatMap(t=>t.seasons?.flatMap(s=>s.schedules??[])??[]) };
    }
}
