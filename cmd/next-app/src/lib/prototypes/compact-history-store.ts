/** Raw-retaining persistence checkpoint. No cron/default reader/deletion activation. */
import { deepStrictEqual } from 'node:assert';
import { createHash,randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { LatestEnergySnapshot,LatestBatterySoc,CycleAggregateRow,DailyCoverageStat } from '../energy-repo';
import type { EnergyData, Tariff, TariffSchedule, TariffSeason } from '../db-types';
import { addDaysInSiteTimezone, getSiteMidnight,parseSiteLocalDateToMidnight,formatSiteDate } from '../date-utils';
import {equalRecoveryValue,recoverVerifiedSamples,rawDayDigest,type RecoveryArchive,type EnergyWrite} from './compact-energy-recovery';
import {validateMaintenanceDates,type MaintenanceSnapshot} from './compact-history-maintenance';
import { auditTariffAttribution } from './compact-tariff-audit';
import { decodeDay, decodeDaySamples, encodeDay, encodeDaySamples, rollupDay, toSample, type DayArchive, type DayRollup, type EnergySample } from './compact-energy';
import {buildLatestMetadata,verifyLatestMetadata,type LatestMetadata,type LatestSample} from './compact-latest-metadata';
import { buildDayMetadata, buildDayMetadataV3, type SummarizedHistoryDay } from './compact-day-metadata';
import { DAY_GAP_HEAL_DAYS, dayStatus, deriveDayAttribution, type DayAttribution, type DayStatus, type GapPricer } from './day-attribution';
import { Schedule } from '../schedule';
import {beginTransaction} from '../pg-transaction';
import {REATTRIBUTABLE,convertV1Day,type V1ConversionReason} from './compact-v1-conversion';
import type { ScalarHistorySnapshot, AggregateHistorySnapshot, FinalizedHistoryDay, HistorySnapshot, HistorySnapshotStore } from './compact-history-reader';

type RawRecord = { site_id: string; timestamp: Date; tariff_id: number; tariff_schedule_id: number | null;
    load_power: number | string; solar_power: number | string; grid_power: number | string;
    battery_power: number | string; battery_soc: number | string | null };
const columns = 'site_id,timestamp,tariff_id,tariff_schedule_id,load_power,solar_power,grid_power,battery_power,battery_soc';
const raw = (r: RawRecord): EnergyData => ({ ...r, timestamp: new Date(r.timestamp), tariff_id: Number(r.tariff_id),
    tariff_schedule_id: r.tariff_schedule_id === null ? null : Number(r.tariff_schedule_id),
    load_power: Number(r.load_power), solar_power: Number(r.solar_power), grid_power: Number(r.grid_power),
    battery_power: Number(r.battery_power), battery_soc: r.battery_soc === null ? null : Number(r.battery_soc) });
type ArchiveRecord=RecoveryArchive;
/**
 * An `EnergyDayArchive` row (alias `a`) that planning and gap-heal treat as a
 * finished day. A v2 record (metadata 3) is settled once `complete` or
 * `gapped`; an `open` one (today, or a recent day short of samples) is not, so
 * its stored samples count and gap-heal refetches it. A v1 archive needs
 * verified metadata, complete tariff attribution, and either every 5-minute
 * slot present or raw already trimmed (the archive is then the only copy, and
 * re-fetching would restore and drop it). An unpruned v1 archive with holes is
 * not settled, so its raw coverage still decides.
 */
export const SETTLED_ARCHIVE_DAY_SQL=`(a.metadata_checksum IS NOT NULL AND CASE WHEN a.metadata_version=3 THEN a.status IN ('complete','gapped')
    ELSE a.metadata_version=2 AND a.attribution_complete AND (a.raw_pruned OR a.sample_count>=a.expected_slots) END)`;
/** Archive rows whose day metadata is checksummed (v1 archives on metadata 2, v2 records on metadata 3). */
const MODERN_METADATA_SQL=(alias='')=>`${alias}metadata_version IN (2,3) AND ${alias}metadata_checksum IS NOT NULL`;

type DetailArchiveRecord = Pick<ArchiveRecord, 'site_id'|'day_start'|'day_end'|'revision'|'format_version'|'codec'|'axis'|'checksum'|'payload'|'expected_slots'|'attribution_complete'|'attribution'>;
const detailColumns = 'site_id,day_start,day_end,revision,format_version,codec,axis,checksum,payload,expected_slots,attribution_complete,attribution';
const archiveOf=(a:DetailArchiveRecord):DayArchive=>({codec:a.codec,axis:a.axis,sha256:a.checksum,data:a.payload,expectedSlots:a.expected_slots});
type LatestArchiveRecord=Pick<ArchiveRecord,'site_id'|'day_start'|'day_end'|'format_version'|'checksum'|'latest_metadata'|'latest_checksum'>;
const latestColumns='site_id,day_start,day_end,format_version,checksum,latest_metadata,latest_checksum';
const projectedEnergy=(s:LatestSample):LatestEnergySnapshot=>({...s,timestamp:new Date(s.timestamp)});
function verifyLatest(a:LatestArchiveRecord):LatestMetadata {
    if((a.format_version!==1&&a.format_version!==2)||!a.latest_metadata||!a.latest_checksum)throw new Error('Latest metadata mismatch');
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
/** A day's chart payload and summaries for the reader; format 2 carries its segment timeline. */
function detailDay(a:DetailArchiveRecord,summaries:SummaryRecord[]):FinalizedHistoryDay {
    if((a.format_version!==1&&a.format_version!==2)||(a.format_version===2)!==(a.attribution!==null))throw new Error('Unsupported archive version');
    return {siteId:a.site_id,start:new Date(a.day_start),end:new Date(a.day_end),attributionComplete:a.attribution_complete,archive:archiveOf(a),
        summaries:summaries.filter(s=>s.revision===a.revision).map(summary),...(a.attribution?{attribution:a.attribution}:{})};
}
export interface ArchiveMutationResult {status:'busy'|'trimmed'|'already-trimmed'|'restored'|'not-pruned';samples:number}
export interface FinalizationResult { status: 'busy' | 'empty' | 'finalized' | 'unchanged'; revision?: string;attributionComplete?:boolean }
/**
 * `superseded`: the stored record came from a newer (or the same) fetch and was kept.
 * `checked-empty`: Tesla answered with no samples for a day with nothing stored; recorded in "EnergyDayEmpty".
 * `empty`: Tesla answered with no samples for a day that has a record or raw rows, which were kept.
 */
export interface DayWriteResult { status:'busy'|'empty'|'checked-empty'|'written'|'superseded'; revision?:string; attributionComplete?:boolean; dayStatus?:DayStatus }
/** One site's day records re-keyed to a new timezone (see `rebuildTimezone`). */
export interface TimezoneRebuildResult { status:'busy'|'unchanged'|'previewed'|'rebuilt'; from?:string; sourceDays?:number; records?:number; restoredRawSamples?:number; droppedEmptyMarkers?:number }
/** v1 -> v2 conversion of one archive; `convertible` is a preview's verified result. */
/** `reattributed` (`reattributable` in preview): a day v2 cannot reproduce, kept as samples with segments from the current tariff (`reattribute`). */
export interface DayConversionResult { status:'busy'|'converted'|'convertible'|'reattributed'|'reattributable'|'already-v2'|'left-v1'; reason?:V1ConversionReason; revision?:string; dayStatus?:DayStatus }
/** An archive row with its site's timezone and its revision's summaries (JSON, read with full float precision). */
type ConversionRecord=ArchiveRecord&{created_at:Date;timezone:string|null;summaries:SummaryRecord[]};
type PreparedDay={archive:DayArchive;summaries:DayRollup[];attributionComplete:boolean;metadata:SummarizedHistoryDay;payloadChecksum:string;
    latest:{data:LatestMetadata;checksum:string};record?:{attribution:DayAttribution;status:DayStatus;fetchedAt:Date}};

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
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');
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
            const days = archives.rows.map(a => detailDay(a,summaries.rows));
            await client.query('COMMIT');
            return { raw: samples.rows.map(raw), days };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async getLatestEnergyData(siteId:string,asOf=new Date()):Promise<LatestEnergySnapshot|null> {
        if(!siteId||!Number.isSafeInteger(+asOf))throw new Error('Invalid latest energy window');
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
            const rawRow=(await client.query<RawRecord>(`SELECT ${columns} FROM "EnergyData" WHERE site_id=$1 AND timestamp<=$2 ORDER BY timestamp DESC LIMIT 1`,[siteId,asOf])).rows[0];
            let result:LatestEnergySnapshot|null=rawRow?{timestamp:new Date(rawRow.timestamp),batterySoc:rawRow.battery_soc===null?null:Number(rawRow.battery_soc),batteryPower:Number(rawRow.battery_power),solarPower:Number(rawRow.solar_power),gridPower:Number(rawRow.grid_power),loadPower:Number(rawRow.load_power)}:null;
            const archives=(await client.query<LatestArchiveRecord>(`SELECT ${latestColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<=$2
                ORDER BY day_start DESC LIMIT 2`,[siteId,asOf])).rows;
            for(const a of archives) {
                let sample:LatestEnergySnapshot|null=null;
                if(a.latest_metadata && verifyLatest(a).sample.timestamp<=+asOf)sample=projectedEnergy(a.latest_metadata.sample);
                else {
                    const detail=(await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2`,[siteId,a.day_start])).rows[0];
                    const rows=this.decodeSamples(detail);
                    const row=rows.findLast(r=>r.timestamp<=asOf);
                    if(row)sample={timestamp:row.timestamp,batterySoc:row.battery_soc??null,batteryPower:row.battery_power,solarPower:row.solar_power,gridPower:row.grid_power,loadPower:row.load_power};
                }
                if(sample){if(!result||sample.timestamp>result.timestamp)result=sample;break;}
            }
            await client.query('COMMIT');return result;
        } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }

    async getLatestBatterySoc(siteId:string,since:Date,now=new Date()):Promise<LatestBatterySoc|null> {
        if(!siteId||!Number.isSafeInteger(+since)||!Number.isSafeInteger(+now)||+now-+since>366*86400000)throw new Error('Invalid SOC window or exceeds 366 days');
        if(since>now)return null;
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
            const rawRow=(await client.query<{timestamp:Date;battery_soc:number}>(`SELECT timestamp,battery_soc FROM "EnergyData" WHERE site_id=$1 AND timestamp>=$2 AND timestamp<=$3 AND battery_soc IS NOT NULL ORDER BY timestamp DESC LIMIT 1`,[siteId,since,now])).rows[0];
            const guard=(await client.query<{verified:boolean;legacy:boolean;cut:boolean}>(`SELECT COALESCE(bool_and(CASE WHEN latest_metadata IS NOT NULL THEN public.verify_compact_latest_metadata(site_id,day_start) ELSE true END),true) AS verified,
                COALESCE(bool_or(latest_metadata IS NULL),false) AS legacy,
                COALESCE(bool_or(day_end>$3 AND (latest_metadata->'soc'->>'timestamp')::bigint>$4),false) AS cut
                FROM "EnergyDayArchive" WHERE site_id=$1 AND day_end>$2 AND day_start<=$3`,[siteId,since,now,+now])).rows[0];
            if(!guard.verified)throw new Error('Latest metadata mismatch');
            if(guard.legacy)throw new Error('Latest SOC metadata requires rebuild');
            const archive=(await client.query<LatestArchiveRecord>(`SELECT ${latestColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND latest_metadata IS NOT NULL
                AND (latest_metadata->'soc'->>'timestamp')::bigint >= $2 AND (latest_metadata->'soc'->>'timestamp')::bigint <= $3
                ORDER BY (latest_metadata->'soc'->>'timestamp')::bigint DESC LIMIT 1`,[siteId,+since,+now])).rows[0];
            let result:LatestBatterySoc|null=rawRow?{timestamp:new Date(rawRow.timestamp),value:Number(rawRow.battery_soc)}:null;
            const consider=(timestamp:number,value:number)=>{if(!result||timestamp>+result.timestamp)result={timestamp:new Date(timestamp),value};};
            if(archive) {
                const charge=verifyLatest(archive).soc;
                if(charge)consider(charge.timestamp,charge.value);
            }
            // Only the day containing the cutoff can project a SOC after it while holding earlier SOC
            // samples (a historical cutoff); its payload is read just then.
            if(guard.cut) {
                const detail=(await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<=$2 AND day_end>$2`,[siteId,now])).rows[0];
                const sample=this.decodeSamples(detail).findLast(s=>s.battery_soc!==null&&s.timestamp>=since&&s.timestamp<=now);
                if(sample)consider(+sample.timestamp,sample.battery_soc!);
            }
            await client.query('COMMIT');return result;
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }

    /**
     * Scalar modern freshness, today's open record included; only legacy
     * metadata, or a record with samples after `asOf`, needs the day's payload.
     */
    async getLatestTimestamp(siteId:string,asOf=new Date()):Promise<Date|null> {
        if(!siteId||!Number.isSafeInteger(+asOf)) throw new Error('Invalid site');
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query("SET LOCAL statement_timeout='15s'");
            const rawLatest=(await client.query<{timestamp:Date}>(`SELECT timestamp FROM "EnergyData"
                WHERE site_id=$1 AND timestamp<=$2 ORDER BY timestamp DESC LIMIT 1`,[siteId,asOf])).rows[0]?.timestamp;
            // The day containing asOf may have no sample at or before it yet; the previous day then has the latest.
            const archives=(await client.query<{day_start:Date;day_end:Date;last_timestamp:Date|null;modern:boolean;verified:boolean}>(`SELECT day_start,day_end,last_timestamp,
                (${MODERN_METADATA_SQL()}) AS modern,
                CASE WHEN ${MODERN_METADATA_SQL()}
                    THEN public.verify_compact_day_metadata(site_id,day_start,false) ELSE true END AS verified
                FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<=$2 ORDER BY day_start DESC LIMIT 2`,[siteId,asOf])).rows;
            let archivedLatest:Date|null=null;
            for(const archive of archives) {
                if(!archive.verified) throw new Error('Day metadata mismatch');
                if(archive.modern&&archive.last_timestamp&&archive.last_timestamp<=asOf) archivedLatest=new Date(archive.last_timestamp);
                else {
                    const a=(await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive"
                        WHERE site_id=$1 AND day_start=$2`,[siteId,archive.day_start])).rows[0];
                    archivedLatest=this.decodeSamples(a).findLast(sample=>sample.timestamp<=asOf)?.timestamp??null;
                }
                if(archivedLatest)break;
            }
            const candidates=[rawLatest?new Date(rawLatest):null,archivedLatest].filter((d):d is Date=>d!==null);
            await client.query('COMMIT');
            return candidates.length?new Date(Math.max(...candidates.map(Number))):null;
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    }

    private decodeSamples(a:DetailArchiveRecord):EnergySample[] {
        if(a.format_version!==1&&a.format_version!==2)throw new Error('Unsupported archive version');
        return decodeDaySamples(archiveOf(a),{siteId:a.site_id,start:new Date(a.day_start),end:new Date(a.day_end)});
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
        // This is the only path that deletes raw samples or reinserts them, so it
        // must be serialized against control edits. A guard is required here rather
        // than optional: silently skipping it would let an unpaused run trim.
        if(!this.mutationGuard)throw new Error('A mutation guard is required to trim or restore an archive');
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL READ COMMITTED');
            await this.boundTransaction(client);
            await client.query("SET LOCAL statement_timeout='15s'");await client.query("SET LOCAL lock_timeout='3s'");
            await this.mutationGuard(client);
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
            await beginTransaction(client,'ISOLATION LEVEL READ COMMITTED');
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
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');
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
                format_version IN (1,2) AND CASE WHEN payload_checksum IS NOT NULL THEN payload_checksum=encode(sha256(payload),'hex') ELSE true END AND CASE WHEN ${MODERN_METADATA_SQL()}
                    THEN public.verify_compact_day_metadata(site_id,day_start,false) ELSE true END
                    AND CASE WHEN latest_metadata IS NOT NULL THEN public.verify_compact_latest_metadata(site_id,day_start) ELSE true END AS verified,
                ${MODERN_METADATA_SQL()} AND latest_metadata IS NOT NULL AND payload_checksum IS NOT NULL AS modern
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
            await beginTransaction(client,'ISOLATION LEVEL READ COMMITTED');
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
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query("SET LOCAL statement_timeout='15s'");
            const site=await client.query<{timezone:string}>('SELECT timezone FROM "Site" WHERE id=$1',[siteId]);
            // Deliberately omit payload: complete modern days require only scalar metadata.
            const full=await client.query<Omit<ArchiveRecord,'payload'>>(`SELECT site_id,day_start,day_end,revision,format_version,codec,axis,checksum,
                expected_slots,sample_count,attribution_complete,first_timestamp,last_timestamp,max_interior_gap_ms,metadata_checksum,metadata_version,attribution
                FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start >= $2 AND day_end <= $3 AND metadata_checksum IS NOT NULL ORDER BY day_start`,[siteId,start,end]);
            const partial=await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<$3 AND day_end>$2
                AND NOT (day_start >= $2 AND day_end <= $3 AND metadata_checksum IS NOT NULL) ORDER BY day_start`,[siteId,start,end]);
            const summaries=(await client.query<SummaryRecord>(`SELECT s.* FROM "EnergyDaySummary" s JOIN "EnergyDayArchive" a USING (site_id,day_start,revision)
                WHERE a.site_id=$1 AND a.day_start<$3 AND a.day_end>$2 ORDER BY s.day_start,s.tariff_id,s.tariff_schedule_id NULLS FIRST`,[siteId,start,end])).rows;
            const samples=await client.query<RawRecord>(`SELECT ${columns} FROM "EnergyData" e WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3
                AND NOT EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=e.site_id AND e.timestamp >= a.day_start AND e.timestamp < a.day_end)
                ORDER BY timestamp LIMIT 105409`,[siteId,start,end]);
            if (samples.rows.length>105408) throw new Error('History sample limit exceeded');
            const parts=partial.rows.map(a=>detailDay(a,summaries));
            const fullDays=full.rows.map(a=>({siteId:a.site_id,start:new Date(a.day_start),end:new Date(a.day_end),attributionComplete:a.attribution_complete,
                sampleCount:a.sample_count,first:new Date(a.first_timestamp??NaN),last:new Date(a.last_timestamp??NaN),
                maxInteriorGapMs:a.max_interior_gap_ms??NaN,checksum:a.metadata_checksum??'',checksumVersion:a.metadata_version,summaries:summaries.filter(s=>s.revision===a.revision).map(summary),
                ...(a.metadata_version===3&&a.attribution?{attribution:a.attribution}:{})}));
            if (full.rows.some(a=>a.format_version!==1&&a.format_version!==2)) throw new Error('Unsupported archive version');
            await client.query('COMMIT');
            return {timezone:site.rows[0]?.timezone??null,fullDays,detail:{raw:samples.rows.map(raw),days:parts}};
        } catch (error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
    }

    async readScalarSnapshot(siteId:string,start:Date,end:Date,mode:{billing:boolean;coverage:boolean}):Promise<ScalarHistorySnapshot> {
        if(!siteId || !Number.isSafeInteger(+start)||!Number.isSafeInteger(+end)||+end-+start>366*86400000) throw new Error('History window invalid or exceeds 366 days');
        if(start>=end) return {timezone:null,aggregates:[],coverage:[],detail:{raw:[],days:[]}};
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
            const site=await client.query<{timezone:string;has_detail:boolean;has_raw:boolean;verified:boolean;attribution_complete:boolean}>(`SELECT timezone,
                EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start<$3 AND a.day_end>$2
                    AND NOT(a.day_start >= $2 AND a.day_end <= $3 AND ${MODERN_METADATA_SQL('a.')})) AS has_detail,
                EXISTS (SELECT 1 FROM "EnergyData" e WHERE e.site_id=$1 AND e.timestamp >= $2 AND e.timestamp < $3
                    AND NOT EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=e.site_id AND e.timestamp>=a.day_start AND e.timestamp<a.day_end)) AS has_raw,
                COALESCE((SELECT bool_and(public.verify_compact_day_metadata(a.site_id,a.day_start,false))
                    FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start >= $2 AND a.day_end <= $3
                    AND ${MODERN_METADATA_SQL('a.')}),true) AS verified,
                COALESCE((SELECT bool_and(a.attribution_complete AND NOT EXISTS (
                    SELECT 1 FROM "EnergyDaySummary" s WHERE s.site_id=a.site_id AND s.day_start=a.day_start AND s.revision=a.revision AND s.tariff_schedule_id IS NULL
                )) FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start >= $2 AND a.day_end <= $3
                    AND ${MODERN_METADATA_SQL('a.')}),true) AS attribution_complete
                FROM "Site" WHERE id=$1`,[siteId,start,end]);
            if(site.rows[0] && !site.rows[0].verified) throw new Error('Day metadata mismatch');
            const timezone=site.rows[0]?.timezone??null;
            const aggregates:CycleAggregateRow[]=[];const coverage:DailyCoverageStat[]=[];
            const eligible=`SELECT a.site_id,a.day_start,a.revision,a.first_timestamp,a.last_timestamp,a.sample_count,a.max_interior_gap_ms,
                ${SETTLED_ARCHIVE_DAY_SQL} AS settled,(a.metadata_version=3 AND a.status='open') AS is_open FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start >= $2 AND a.day_end <= $3
                AND ${MODERN_METADATA_SQL('a.')}`;
            if(mode.billing) {
                const result=await client.query<CycleAggregateRow>(`WITH eligible AS MATERIALIZED (${eligible})
                    SELECT s.day_start AS day,s.tariff_id,s.tariff_schedule_id,s.load_power,s.solar_power,s.grid_power,s.battery_power
                    FROM "EnergyDaySummary" s JOIN eligible a USING(site_id,day_start,revision) ORDER BY day,tariff_id,tariff_schedule_id`,[siteId,start,end]);
                aggregates.push(...result.rows.map(r=>({...r,day:new Date(r.day),tariff_id:Number(r.tariff_id),tariff_schedule_id:r.tariff_schedule_id===null?null:Number(r.tariff_schedule_id),
                    load_power:Number(r.load_power),solar_power:Number(r.solar_power),grid_power:Number(r.grid_power),battery_power:Number(r.battery_power)})));
            }
            if(mode.coverage && timezone) {
                const result=await client.query<{key:string;count:number;first:Date;last:Date;gap:number;settled:boolean;is_open:boolean}>(`WITH eligible AS MATERIALIZED (${eligible})
                    SELECT to_char(day_start AT TIME ZONE $4::text,'YYYY-MM-DD') AS key,sample_count AS count,
                        first_timestamp AS first,last_timestamp AS last,max_interior_gap_ms AS gap,settled,is_open FROM eligible ORDER BY day_start`,[siteId,start,end,timezone]);
                coverage.push(...result.rows.map(r=>({localDayKey:r.key,count:r.count,first:new Date(r.first),last:new Date(r.last),maxInteriorGapMs:r.gap,archived:r.settled,...(r.is_open?{open:true}:{})})));
            }
            const partial=site.rows[0]?.has_detail?await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<$3 AND day_end>$2
                AND NOT (day_start >= $2 AND day_end <= $3 AND ${MODERN_METADATA_SQL()}) ORDER BY day_start`,[siteId,start,end]):{rows:[]};
            const summaries=partial.rows.length?(await client.query<SummaryRecord>(`SELECT s.* FROM "EnergyDaySummary" s JOIN "EnergyDayArchive" a USING(site_id,day_start,revision)
                WHERE a.site_id=$1 AND a.day_start<$3 AND a.day_end>$2 AND NOT (a.day_start >= $2 AND a.day_end <= $3 AND ${MODERN_METADATA_SQL('a.')})
                ORDER BY s.day_start,s.tariff_id,s.tariff_schedule_id NULLS FIRST`,[siteId,start,end])).rows:[];
            const rawRows=site.rows[0]?.has_raw?await client.query<RawRecord>(`SELECT ${columns} FROM "EnergyData" e WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3
                AND NOT EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=e.site_id AND e.timestamp>=a.day_start AND e.timestamp<a.day_end)
                ORDER BY timestamp LIMIT 105409`,[siteId,start,end]):{rows:[]};
            if(rawRows.rows.length>105408) throw new Error('History sample limit exceeded');
            const days=partial.rows.map(a=>detailDay(a,summaries));
            await client.query('COMMIT');return {attributionComplete:site.rows[0]?.attribution_complete??true,timezone,aggregates,coverage,detail:{raw:rawRows.rows.map(raw),days}};
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    }

    async finalizeDay(siteId: string, start: Date, now = new Date()): Promise<FinalizationResult> {
        const client = await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL READ COMMITTED');
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
            const {archive,summaries,attributionComplete,metadata,payloadChecksum,latest}=await this.prepareDay(client,siteId,timezone,start,end,rows);
            // A day converted from v1 keeps its record while it still recovers to exactly the raw rows.
            if(old?.format_version===2&&old.attribution_complete===attributionComplete&&+old.day_end===+end) {
                let same=false;
                try {same=equalRecoveryValue(await this.recoverySamples(client,old),rows);} catch { /* Rebuild a damaged record from raw. */ }
                if(same) {await client.query('COMMIT');return {status:'unchanged',revision:old.revision,attributionComplete};}
            }
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
            const revision=await this.replaceDay(client,siteId,start,end,rows.length,{archive,summaries,attributionComplete,metadata,payloadChecksum,latest},false);
            await client.query('COMMIT');
            return { status:'finalized', revision,attributionComplete };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(this.transactionTimeoutMs!==undefined); }
    }

    /**
     * Write one site-local day, today included, straight from a Tesla fetch as the
     * only copy (format 2: samples, plus a segment timeline from the site's current
     * tariff). No raw rows are written or read back, so it costs no read egress.
     * Tesla is the source of truth, so the record is replaced, but only by a newer
     * fetch: an older, slower response is `superseded` and changes nothing.
     * Refuses a day that still has raw rows, whose archive the raw source owns,
     * unless `replaceRaw`: the importer's fetch then replaces both representations,
     * deleting the day's raw rows in the same transaction (no read-back).
     */
    async writeDay(siteId:string,start:Date,samples:EnergySample[],fetchedAt:Date,now=new Date(),{replaceRaw=false}:{replaceRaw?:boolean}={}):Promise<DayWriteResult> {
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL READ COMMITTED');
            await this.boundTransaction(client);
            await client.query("SET LOCAL statement_timeout = '15s'");
            await client.query("SET LOCAL lock_timeout = '3s'");
            await this.mutationGuard?.(client);
            if(!await this.claimMutation(client,siteId)) {await client.query('ROLLBACK');return {status:'busy'};}
            const timezone=(await client.query<{timezone:string}>('SELECT timezone FROM "Site" WHERE id=$1',[siteId])).rows[0]?.timezone;
            if(!timezone||!Number.isSafeInteger(+start)||!Number.isSafeInteger(+now)||+start!==+getSiteMidnight(start,timezone)||start>now)throw new Error('Expected a started local day');
            // A fetch time from the future would lock the day against every later fetch.
            if(!Number.isSafeInteger(+fetchedAt)||fetchedAt>now)throw new Error('Invalid fetch time');
            const end=addDaysInSiteTimezone(start,1,timezone);
            if(samples.length>4096||samples.some(r=>r.site_id!==siteId||!(r.timestamp>=start&&r.timestamp<end)))throw new Error('Samples outside the site day');
            // Status compares sample_count with the day's 5-minute slots, so every sample must own one.
            if(samples.some(r=>(+r.timestamp-+start)%300000))throw new Error('Samples off the 5-minute grid');
            if(!samples.length) {
                // Published samples never disappear, so an empty answer for a day with stored samples is a
                // Tesla failure and changes nothing; for a day with nothing stored it is a durable check.
                const kept=(await client.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2)
                    OR EXISTS(SELECT 1 FROM "EnergyData" WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3) AS present`,[siteId,start,end])).rows[0].present;
                if(!kept)await client.query(`INSERT INTO "EnergyDayEmpty" (site_id,day_start,day_end,checked_at) VALUES ($1,$2,$3,$4)
                    ON CONFLICT (site_id,day_start) DO UPDATE SET checked_at=EXCLUDED.checked_at WHERE "EnergyDayEmpty".checked_at<EXCLUDED.checked_at`,[siteId,start,end,fetchedAt]);
                await client.query('COMMIT');return {status:kept?'empty':'checked-empty'};
            }
            if(!replaceRaw) {
                const raw=(await client.query<{present:boolean}>('SELECT EXISTS(SELECT 1 FROM "EnergyData" WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3) AS present',[siteId,start,end])).rows[0].present;
                if(raw)throw new Error('Day still has raw samples; finalize it from raw instead');
            }
            const stored=(await client.query<{revision:string;fetched_at:Date|null}>('SELECT revision,fetched_at FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2 FOR UPDATE',[siteId,start])).rows[0];
            if(stored?.fetched_at&&+fetchedAt<=+stored.fetched_at) {await client.query('COMMIT');return {status:'superseded',revision:stored.revision};}
            const sorted=samples.map(toSample).sort((a,b)=>+a.timestamp-+b.timestamp);
            const {tariffs}=await this.tariffs(client,siteId,true);
            const prepared=this.prepareSamples(siteId,timezone,start,end,sorted,tariffs,fetchedAt,now);
            if(replaceRaw) {
                // Archive first: the raw-delete trigger (invalidate_compact_energy_day) refuses an unpruned
                // archive whose sample count no longer matches raw; with none left it only deletes the rows.
                await client.query('DELETE FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[siteId,start]);
                await client.query('DELETE FROM "EnergyData" WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3',[siteId,start,end]);
            }
            await client.query('DELETE FROM "EnergyDayEmpty" WHERE site_id=$1 AND day_start=$2',[siteId,start]);
            const revision=await this.replaceDay(client,siteId,start,end,sorted.length,prepared,true);
            await client.query('COMMIT');
            return {status:'written',revision,attributionComplete:prepared.attributionComplete,dayStatus:prepared.record!.status};
        } catch(error) {await client.query('ROLLBACK');throw error;}
        finally {client.release(this.transactionTimeoutMs!==undefined);}
    }

    /** A day record's status (null for v1) and fetch time, for deciding whether Tesla's answer for it is final. */
    async getDayRecordState(siteId:string,start:Date):Promise<{status:DayStatus|null;fetchedAt:Date|null}|null> {
        const row=(await this.pool.query<{status:DayStatus|null;fetched_at:Date|null}>('SELECT status,fetched_at FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[siteId,start])).rows[0];
        return row?{status:row.status,fetchedAt:row.fetched_at}:null;
    }

    /**
     * Days a backfill need not fetch again: Tesla answered them with no samples in a
     * request made after the day ended, they are older than the gap-heal window (the
     * age rule that makes a short day `gapped`), and nothing has been stored since.
     * A day with no marker was never answered (or its fetch failed) and is fetched.
     */
    async getSettledEmptyDays(siteId:string,from:Date,before:Date,now:Date):Promise<Date[]> {
        const rows=(await this.pool.query<{day_start:Date}>(`SELECT e.day_start FROM "EnergyDayEmpty" e
            WHERE e.site_id=$1 AND e.day_start >= $2 AND e.day_start < $3 AND e.checked_at >= e.day_end AND e.day_end < $4::timestamptz - make_interval(days => $5)
            AND NOT EXISTS(SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=e.site_id AND a.day_start=e.day_start)
            AND NOT EXISTS(SELECT 1 FROM "EnergyData" r WHERE r.site_id=e.site_id AND r.timestamp >= e.day_start AND r.timestamp < e.day_end)
            ORDER BY e.day_start`,[siteId,from,before,now,DAY_GAP_HEAL_DAYS])).rows;
        return rows.map(r=>new Date(r.day_start));
    }

    /**
     * Re-key every stored day of a site to a new timezone in one transaction, so old
     * and new local-day partitions never coexist and no Tesla request is needed
     * (tokenless sites included). Pruned days are decoded (verified as recovery
     * does) and regrouped by the new local midnight. A new day built only from
     * pruned samples becomes a v2 record, segments from the current tariff under the
     * new timezone, `fetched_at` its oldest source's. A new day that also has raw
     * rows gets its pruned samples back as raw rows, so raw stays its only source
     * until it is archived or refetched. Unpruned archives are dropped (their raw
     * rows stay) and so are empty-day markers. Preview does the same work and rolls back.
     */
    async rebuildTimezone(siteId:string,timezone:string,{apply,now}:{apply:boolean;now:Date}):Promise<TimezoneRebuildResult> {
        if(!siteId?.trim()||siteId.length>200||!Number.isSafeInteger(+now))throw new Error('Invalid timezone rebuild request');
        new Intl.DateTimeFormat('en-US',{timeZone:timezone});
        if(apply&&!this.mutationGuard)throw new Error('A mutation guard is required to rebuild a site\'s days');
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL READ COMMITTED');
            await this.boundTransaction(client);
            await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'");
            if(apply)await this.mutationGuard!(client);
            if(!await this.claimMutation(client,siteId)) {await client.query('ROLLBACK');return {status:'busy'};}
            const from=(await client.query<{timezone:string}>('SELECT timezone FROM "Site" WHERE id=$1 FOR UPDATE',[siteId])).rows[0]?.timezone;
            if(!from)throw new Error('Site not found');
            if(from===timezone) {await client.query('COMMIT');return {status:'unchanged',from};}
            // Only pruned days are read: an unpruned archive's raw rows already hold its samples.
            const pruned=(await client.query<ArchiveRecord&{created_at:Date;summaries:SummaryRecord[]}>(`SELECT a.*,COALESCE((SELECT json_agg(x) FROM "EnergyDaySummary" x
                WHERE x.site_id=a.site_id AND x.day_start=a.day_start AND x.revision=a.revision),'[]') AS summaries
                FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.raw_pruned ORDER BY a.day_start`,[siteId])).rows;
            const days=new Map<number,{rows:EnergyData[];fetchedAt:Date}>();
            for(const archive of pruned) {
                const fetchedAt=new Date(archive.fetched_at??archive.created_at);
                for(const row of recoverVerifiedSamples(archive,archive.summaries.map(summary))) {
                    const key=+getSiteMidnight(row.timestamp,timezone);
                    const day=days.get(key);
                    if(!day)days.set(key,{rows:[row],fetchedAt});
                    else {day.rows.push(row);if(fetchedAt<day.fetchedAt)day.fetchedAt=fetchedAt;}
                }
            }
            const droppedEmptyMarkers=(await client.query('DELETE FROM "EnergyDayEmpty" WHERE site_id=$1',[siteId])).rowCount??0;
            const sourceDays=(await client.query('DELETE FROM "EnergyDayArchive" WHERE site_id=$1',[siteId])).rowCount??0;
            // With no archive left the timezone trigger allows the change.
            await client.query('UPDATE "Site" SET timezone=$2 WHERE id=$1',[siteId,timezone]);
            const starts=[...days.keys()].sort((a,b)=>a-b).map(key=>new Date(key));
            const ends=starts.map(start=>addDaysInSiteTimezone(start,1,timezone));
            const withRaw=new Set((await client.query<{s:Date}>(`SELECT r.s FROM unnest($2::timestamptz[],$3::timestamptz[]) AS r(s,e)
                WHERE EXISTS(SELECT 1 FROM "EnergyData" WHERE site_id=$1 AND timestamp >= r.s AND timestamp < r.e)`,[siteId,starts,ends])).rows.map(r=>+r.s));
            const {tariffs}=await this.tariffs(client,siteId,true);
            let records=0,restoredRawSamples=0;
            for(let i=0;i<starts.length;i++) {
                const day=days.get(+starts[i])!;
                if(withRaw.has(+starts[i])) {await this.insertRows(client,day.rows);restoredRawSamples+=day.rows.length;continue;}
                const samples=day.rows.map(toSample).sort((a,b)=>+a.timestamp-+b.timestamp);
                if(samples.some(r=>(+r.timestamp-+starts[i])%300000))throw new Error('Samples off the 5-minute grid in the new timezone');
                await this.replaceDay(client,siteId,starts[i],ends[i],samples.length,this.prepareSamples(siteId,timezone,starts[i],ends[i],samples,tariffs,day.fetchedAt,now),true);
                records++;
            }
            await client.query(apply?'COMMIT':'ROLLBACK');
            return {status:apply?'rebuilt':'previewed',from,sourceDays,records,restoredRawSamples,droppedEmptyMarkers};
        } catch(error) {await client.query('ROLLBACK');throw error;}
        finally {client.release(this.transactionTimeoutMs!==undefined);}
    }

    /**
     * Convert one v1 archive to a format 2 record in place (new revision), keeping
     * the attribution each sample was priced with and `raw_pruned` as stored; raw
     * rows are not read or written. Only a day whose v2 record reads back exactly
     * as the verified v1 archive did is written; otherwise it stays v1 with a
     *  reason. Preview runs the same verification read-only and writes nothing.
     * `reattribute`: an `unattributed-gap` or `attribution-flag` day is re-attributed
     * instead (see `reattributeV1Day`), deleting its raw rows; run only where compact reads are on.
     */
    async convertDayToV2(siteId:string,start:Date,{apply,now,reattribute=false}:{apply:boolean;now:Date;reattribute?:boolean}):Promise<DayConversionResult> {
        if(!siteId?.trim()||siteId.length>200||!Number.isSafeInteger(+start)||!Number.isSafeInteger(+now))throw new Error('Invalid conversion request');
        if(apply&&!this.mutationGuard)throw new Error('A mutation guard is required to convert an archive');
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,apply?'ISOLATION LEVEL READ COMMITTED':'ISOLATION LEVEL REPEATABLE READ READ ONLY');
            if(apply)await this.boundTransaction(client);
            await client.query(apply?"SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'":"SET LOCAL statement_timeout='15s'");
            if(apply) {
                await this.mutationGuard!(client);
                if(!await this.claimMutation(client,siteId)) {await client.query('ROLLBACK');return {status:'busy'};}
            }
            // One round trip for the day: the archive, its site's timezone and its revision's summaries.
            const old=(await client.query<ConversionRecord>(`SELECT a.*,s.timezone,COALESCE((SELECT json_agg(x) FROM "EnergyDaySummary" x
                WHERE x.site_id=a.site_id AND x.day_start=a.day_start AND x.revision=a.revision),'[]') AS summaries
                FROM "EnergyDayArchive" a LEFT JOIN "Site" s ON s.id=a.site_id WHERE a.site_id=$1 AND a.day_start=$2${apply?' FOR UPDATE OF a':''}`,[siteId,start])).rows[0];
            if(!old)throw new Error('Archive day not found');
            const result=await this.convertArchive(client,old,apply,now,reattribute);
            await client.query('COMMIT');return result;
        } catch(error) {await client.query('ROLLBACK');throw error;}
        finally {client.release(apply&&this.transactionTimeoutMs!==undefined);}
    }

    private async convertArchive(client:PoolClient,old:ConversionRecord,apply:boolean,now:Date,reattribute:boolean):Promise<DayConversionResult> {
        if(old.format_version===2)return {status:'already-v2'};
        const left=(reason:V1ConversionReason):DayConversionResult=>({status:'left-v1',reason});
        if(old.format_version!==1||old.metadata_version!==2)return left('legacy-metadata');
        const start=new Date(old.day_start),end=new Date(old.day_end);
        const {timezone}=old;
        try {
            if(!timezone||+start!==+getSiteMidnight(start,timezone)||+end!==+addDaysInSiteTimezone(start,1,timezone))return left('day-bounds');
        } catch {return left('day-bounds');}
        const stored=old.summaries.map(summary);
        let rows:EnergyData[];
        // Verified exactly as recovery and trim do: payload, metadata, summaries and projection.
        try {rows=recoverVerifiedSamples(old,stored);} catch {return left('integrity');}
        const day={siteId:old.site_id,start,end,revision:old.revision,createdAt:new Date(old.created_at),attributionComplete:old.attribution_complete,rows,summaries:stored,now};
        let converted=convertV1Day(day);
        // Only a gap across a period boundary needs the site's tariff versions (a few rows), so the usual day skips them.
        if('reason' in converted&&converted.reason==='unattributed-gap')converted=convertV1Day(day,await this.gapPricer(client,old.site_id,timezone!));
        if('reason' in converted)return reattribute&&REATTRIBUTABLE.has(converted.reason)?this.reattributeV1Day(client,old,rows,apply,now):left(converted.reason);
        const {archive,attribution,metadata,status,fetchedAt,latest,payloadChecksum}=converted.day;
        if(!apply)return {status:'convertible',dayStatus:status};
        const revision=await this.replaceDay(client,old.site_id,start,end,rows.length,{archive,summaries:metadata.summaries,
            attributionComplete:metadata.attributionComplete,metadata,payloadChecksum,latest,record:{attribution,status,fetchedAt}},old.raw_pruned);
        // The database's own digest check must agree before the conversion commits.
        await client.query('SELECT public.verify_compact_day_metadata($1,$2,false)',[old.site_id,start]);
        return {status:'converted',revision,dayStatus:status};
    }

    /**
     * A v1 day whose attribution v2 cannot reproduce keeps its samples and takes
     * segments from the current tariff, as every importer write (and a Tesla
     * refetch of the same samples) would; no Tesla request, so tokenless sites
     * too. Raw rows still holding the day are first proven equal to the archive in
     * the database (no read-back), then deleted with it as `writeDay(..., {replaceRaw})`
     * does: their per-sample IDs are the attribution being replaced.
     */
    private async reattributeV1Day(client:PoolClient,old:ConversionRecord,rows:EnergyData[],apply:boolean,now:Date):Promise<DayConversionResult> {
        const start=new Date(old.day_start),end=new Date(old.day_end);
        if(!old.raw_pruned) {
            const source=(await client.query<{digest:string;samples:number}>('SELECT * FROM public.compact_raw_day_digest($1,$2,$3)',[old.site_id,start,end])).rows[0];
            if(source.samples!==rows.length||source.digest!==rawDayDigest(rows,old.site_id,start,end))return {status:'left-v1',reason:'raw-mismatch'};
        }
        const {tariffs}=await this.tariffs(client,old.site_id,true);
        if(!tariffs.length)return {status:'left-v1',reason:'no-current-tariff'};
        const prepared=this.prepareSamples(old.site_id,old.timezone!,start,end,rows.map(toSample),tariffs,new Date(old.created_at),now);
        if(!apply)return {status:'reattributable',dayStatus:prepared.record!.status};
        if(!old.raw_pruned) {
            // Archive first, as writeDay does: with no archive left the raw-delete trigger only deletes the rows.
            await client.query('DELETE FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[old.site_id,start]);
            const deleted=await client.query('DELETE FROM "EnergyData" WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3',[old.site_id,start,end]);
            if(deleted.rowCount!==rows.length)throw new Error('Re-attribution raw row count mismatch');
        }
        const revision=await this.replaceDay(client,old.site_id,start,end,rows.length,prepared,true);
        await client.query('SELECT public.verify_compact_day_metadata($1,$2,false)',[old.site_id,start]);
        return {status:'reattributed',revision,dayStatus:prepared.record!.status};
    }

    /** Prices a slot under any recorded tariff version (current or not), as the importer did for its samples. */
    private async gapPricer(client:PoolClient,siteId:string,timezone:string):Promise<GapPricer> {
        const {tariffs}=await this.tariffs(client,siteId);
        const versions=new Map<number,Schedule>(tariffs.map(t=>[Number(t.id),new Schedule([t],timezone)]));
        return (timestamp,tariffId)=>{
            const period=versions.get(tariffId)?.getTariffPeriod(timestamp);
            return period?Number(period.schedule.id):null;
        };
    }

    /** Format 2: verify the lossless round trip, derive segments from the current tariff, then summaries, status and projections. */
    private prepareSamples(siteId:string,timezone:string,start:Date,end:Date,samples:EnergySample[],tariffs:Tariff[],fetchedAt:Date,now:Date):PreparedDay {
        if(!tariffs.length)throw new Error('No current tariff');
        const archive=encodeDaySamples(samples,start,end,'brotli');
        const recovered=decodeDaySamples(archive,{siteId,start,end});
        deepStrictEqual(recovered,samples);
        const attribution=deriveDayAttribution(new Schedule(tariffs,timezone),Number(tariffs[0].id),start,end);
        const metadata=buildDayMetadataV3(recovered,attribution,start,end);
        const status=dayStatus({end,sampleCount:recovered.length,expectedSlots:archive.expectedSlots,now});
        const payloadChecksum=createHash('sha256').update(archive.data).digest('hex');
        const latest=buildLatestMetadata(recovered,{siteId,start,end,archiveChecksum:archive.sha256});
        return {archive,summaries:metadata.summaries,attributionComplete:metadata.attributionComplete,metadata,payloadChecksum,latest,record:{attribution,status,fetchedAt}};
    }

    /** Encode, verify the lossless round trip and summaries, and audit tariff attribution for one day. */
    private async prepareDay(client:PoolClient,siteId:string,timezone:string,start:Date,end:Date,rows:EnergyData[]):Promise<PreparedDay> {
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
        return {archive,summaries,attributionComplete,metadata,payloadChecksum,latest};
    }

    /** Replace the day's archive and summaries with a new revision (format 2 when the day carries a record). */
    private async replaceDay(client:PoolClient,siteId:string,start:Date,end:Date,sampleCount:number,day:PreparedDay,rawPruned:boolean):Promise<string> {
        const {archive,summaries,attributionComplete,metadata,payloadChecksum,latest,record}=day;
        const revision = randomUUID();
        await client.query('DELETE FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[siteId,start]);
        await client.query(`INSERT INTO "EnergyDayArchive" (site_id,day_start,day_end,revision,format_version,codec,axis,checksum,payload,sample_count,expected_slots,attribution_complete,first_timestamp,last_timestamp,max_interior_gap_ms,metadata_checksum,metadata_version,latest_metadata,latest_checksum,payload_checksum,raw_pruned,attribution,status,fetched_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,[siteId,start,end,revision,record?2:1,archive.codec,archive.axis,archive.sha256,archive.data,sampleCount,archive.expectedSlots,attributionComplete,metadata.first,metadata.last,metadata.maxInteriorGapMs,metadata.checksum,record?3:2,JSON.stringify(latest.data),latest.checksum,payloadChecksum,rawPruned,
            record?JSON.stringify(record.attribution):null,record?.status??null,record?.fetchedAt??null]);
        // One statement for all of the day's summary rows.
        if(summaries.length) await client.query(`INSERT INTO "EnergyDaySummary" (site_id,day_start,revision,tariff_id,tariff_schedule_id,
            load_power,solar_power,grid_power,battery_power,sample_import_wh,sample_export_wh,sample_charge_wh,sample_discharge_wh,sample_count)
            VALUES ${summaries.map((_,i)=>`($1,$2,$3,${Array.from({length:11},(_,j)=>'$'+(4+i*11+j)).join(',')})`).join(',')}`,
            [siteId,start,revision,...summaries.flatMap(s=>[s.tariff_id,s.tariff_schedule_id,
                s.load_power,s.solar_power,s.grid_power,s.battery_power,s.sample_import_wh,s.sample_export_wh,s.sample_charge_wh,s.sample_discharge_wh,s.sample_count])]);
        return revision;
    }

    /** Every tariff version (for auditing recorded IDs), or only the current ones (for new attribution), ordered by ID. */
    private async tariffs(client: PoolClient,siteId: string,currentOnly=false): Promise<{ tariffs:Tariff[]; schedules:TariffSchedule[] }> {
        const current = currentOnly ? ' AND t.is_current' : '';
        const tariffs = (await client.query<Tariff>(`SELECT t.* FROM "Tariff" t WHERE t.site_id=$1${current} ORDER BY t.id`,[siteId])).rows;
        const seasons = (await client.query<TariffSeason>(`SELECT s.* FROM "TariffSeason" s JOIN "Tariff" t ON t.id=s.tariff_id WHERE t.site_id=$1${current}`,[siteId])).rows;
        const schedules = (await client.query<TariffSchedule>(`SELECT p.* FROM "TariffSchedule" p JOIN "TariffSeason" s ON s.id=p.season_id
            JOIN "Tariff" t ON t.id=s.tariff_id WHERE t.site_id=$1${current}`,[siteId])).rows;
        for (const tariff of tariffs) tariff.seasons = seasons.filter(s=>s.tariff_id===tariff.id).map(s=>({ ...s,
            buy_rate:Number(s.buy_rate), sell_rate:Number(s.sell_rate), schedules:schedules.filter(p=>p.season_id===s.id).map(p=>({ ...p,
                buy_rate:p.buy_rate===null ? null : Number(p.buy_rate), sell_rate:p.sell_rate===null ? null : Number(p.sell_rate) })) }));
        return { tariffs, schedules:tariffs.flatMap(t=>t.seasons?.flatMap(s=>s.schedules??[])??[]) };
    }
}
