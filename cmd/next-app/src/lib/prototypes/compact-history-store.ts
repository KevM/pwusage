/** Day-record persistence (`EnergyDayArchive` + `EnergyDaySummary`): the only energy history store. */
import { deepStrictEqual } from 'node:assert';
import { createHash,randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { LatestEnergySnapshot,LatestBatterySoc,CycleAggregateRow,DailyCoverageStat } from '../energy-repo';
import type { EnergyData, Tariff, TariffSchedule, TariffSeason } from '../db-types';
import { addDaysInSiteTimezone, getSiteMidnight } from '../date-utils';
import {recoverVerifiedSamples,type RecoveryArchive} from './compact-energy-recovery';
import { decodeDaySamples, encodeDaySamples, toSample, type DayArchive, type DayRollup, type EnergySample } from './compact-energy';
import {buildLatestMetadata,verifyLatestMetadata,type LatestMetadata,type LatestSample} from './compact-latest-metadata';
import { buildDayMetadataV3, type SummarizedHistoryDay } from './compact-day-metadata';
import { DAY_GAP_HEAL_DAYS, dayStatus, deriveDayAttribution, type DayAttribution, type DayRecordStatus, type DayStatus, type EmptyDayState } from './day-attribution';
import { Schedule } from '../schedule';
import {beginTransaction} from '../pg-transaction';
import type { ScalarHistorySnapshot, AggregateHistorySnapshot, FinalizedHistoryDay, HistorySnapshot, HistorySnapshotStore } from './compact-history-reader';

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
/**
 * The archive day of `alias` containing timestamp `ts`. Days start at site-local
 * midnight and last at most 25 hours, so the lower bound on `day_start` keeps the
 * index range to a day or two; without it, a per-row probe scans every earlier
 * day of the site (5.5 s on production for gap-heal's 14-day pre-check).
 */
export const ARCHIVE_DAY_CONTAINS_SQL=(ts:string,alias='a')=>`${alias}.day_start<=${ts} AND ${alias}.day_start>${ts}-interval '2 days' AND ${ts}<${alias}.day_end`;
export const SETTLED_ARCHIVE_DAY_SQL=`(a.metadata_checksum IS NOT NULL AND CASE WHEN a.metadata_version=3 THEN a.status IN ('complete','gapped')
    ELSE a.metadata_version=2 AND a.attribution_complete AND (a.raw_pruned OR a.sample_count>=a.expected_slots) END)`;
/** Archive rows whose day metadata is checksummed (v1 archives on metadata 2, v2 records on metadata 3). */
const MODERN_METADATA_SQL=(alias='')=>`${alias}metadata_version IN (2,3) AND ${alias}metadata_checksum IS NOT NULL`;
/**
 * Archive rows that hold samples. An `empty` day record (Tesla answered the day with
 * no samples) has no payload, digest, projection or summaries: readers treat it as
 * "checked, no data" by skipping it, and it never hides raw rows.
 */
export const HAS_SAMPLES_SQL=(alias='')=>`${alias}status IS DISTINCT FROM 'empty'`;

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
/** A day's chart payload and summaries for the reader; format 2 carries its segment timeline. */
function detailDay(a:DetailArchiveRecord,summaries:SummaryRecord[]):FinalizedHistoryDay {
    if((a.format_version!==1&&a.format_version!==2)||(a.format_version===2)!==(a.attribution!==null))throw new Error('Unsupported archive version');
    return {siteId:a.site_id,start:new Date(a.day_start),end:new Date(a.day_end),attributionComplete:a.attribution_complete,archive:archiveOf(a),
        summaries:summaries.filter(s=>s.revision===a.revision).map(summary),...(a.attribution?{attribution:a.attribution}:{})};
}
/**
 * `superseded`: the stored record came from a newer (or the same) fetch and was kept.
 * `checked-empty`: Tesla answered with no samples for a day with nothing stored; recorded as an `empty` day record.
 * `empty`: Tesla answered with no samples for a day that has a record or raw rows, which were kept.
 */
export interface DayWriteResult { status:'busy'|'empty'|'checked-empty'|'written'|'superseded'; revision?:string; attributionComplete?:boolean; dayStatus?:DayStatus }
/** One site's day records re-keyed to a new timezone (see `rebuildTimezone`). */
export interface TimezoneRebuildResult { status:'busy'|'unchanged'|'previewed'|'rebuilt'; from?:string; sourceDays?:number; records?:number; droppedEmptyDays?:number }
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

    async readSnapshot(siteId: string, start: Date, end: Date): Promise<HistorySnapshot> {
        if (!siteId || !Number.isSafeInteger(+start) || !Number.isSafeInteger(+end) || +end - +start > 366 * 86400000) throw new Error('History window invalid or exceeds 366 days');
        if (start >= end) return { raw: [], days: [] };
        const client = await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query("SET LOCAL statement_timeout = '15s'");
            const archives = await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive"
                WHERE site_id=$1 AND day_start < $3 AND day_end > $2 AND ${HAS_SAMPLES_SQL()} ORDER BY day_start`, [siteId,start,end]);
            const summaries = await client.query<SummaryRecord>(`SELECT s.* FROM "EnergyDaySummary" s
                JOIN "EnergyDayArchive" a USING (site_id,day_start,revision)
                WHERE a.site_id=$1 AND a.day_start < $3 AND a.day_end > $2
                ORDER BY s.day_start,s.tariff_id,s.tariff_schedule_id NULLS FIRST`, [siteId,start,end]);
            const days = archives.rows.map(a => detailDay(a,summaries.rows));
            await client.query('COMMIT');
            return { raw: [], days };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async getLatestEnergyData(siteId:string,asOf=new Date()):Promise<LatestEnergySnapshot|null> {
        if(!siteId||!Number.isSafeInteger(+asOf))throw new Error('Invalid latest energy window');
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
            let result:LatestEnergySnapshot|null=null;
            const archives=(await client.query<LatestArchiveRecord>(`SELECT ${latestColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<=$2
                AND ${HAS_SAMPLES_SQL()} ORDER BY day_start DESC LIMIT 2`,[siteId,asOf])).rows;
            for(const a of archives) {
                let sample:LatestEnergySnapshot|null=null;
                if(a.latest_metadata && verifyLatest(a).sample.timestamp<=+asOf)sample=projectedEnergy(a.latest_metadata.sample);
                else {
                    const detail=(await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2`,[siteId,a.day_start])).rows[0];
                    const rows=this.decodeSamples(detail);
                    const row=rows.findLast(r=>r.timestamp<=asOf);
                    if(row)sample={timestamp:row.timestamp,batterySoc:row.battery_soc??null,batteryPower:row.battery_power,solarPower:row.solar_power,gridPower:row.grid_power,loadPower:row.load_power};
                }
                if(sample){result=sample;break;}
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
            const guard=(await client.query<{verified:boolean;legacy:boolean;cut:boolean}>(`SELECT COALESCE(bool_and(CASE WHEN latest_metadata IS NOT NULL THEN public.verify_compact_latest_metadata(site_id,day_start) ELSE true END),true) AS verified,
                COALESCE(bool_or(latest_metadata IS NULL),false) AS legacy,
                COALESCE(bool_or(day_end>$3 AND (latest_metadata->'soc'->>'timestamp')::bigint>$4),false) AS cut
                FROM "EnergyDayArchive" WHERE site_id=$1 AND day_end>$2 AND day_start<=$3 AND ${HAS_SAMPLES_SQL()}`,[siteId,since,now,+now])).rows[0];
            if(!guard.verified)throw new Error('Latest metadata mismatch');
            if(guard.legacy)throw new Error('Latest SOC metadata requires rebuild');
            const archive=(await client.query<LatestArchiveRecord>(`SELECT ${latestColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND latest_metadata IS NOT NULL
                AND (latest_metadata->'soc'->>'timestamp')::bigint >= $2 AND (latest_metadata->'soc'->>'timestamp')::bigint <= $3
                ORDER BY (latest_metadata->'soc'->>'timestamp')::bigint DESC LIMIT 1`,[siteId,+since,+now])).rows[0];
            let result:LatestBatterySoc|null=null;
            const consider=(timestamp:number,value:number)=>{if(!result||timestamp>+result.timestamp)result={timestamp:new Date(timestamp),value};};
            if(archive) {
                const charge=verifyLatest(archive).soc;
                if(charge)consider(charge.timestamp,charge.value);
            }
            // Only the day containing the cutoff can project a SOC after it while holding earlier SOC
            // samples (a historical cutoff); its payload is read just then.
            if(guard.cut) {
                const detail=(await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<=$2 AND day_end>$2 AND ${HAS_SAMPLES_SQL()}`,[siteId,now])).rows[0];
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
            // The day containing asOf may have no sample at or before it yet; the previous day then has the latest.
            const archives=(await client.query<{day_start:Date;day_end:Date;last_timestamp:Date|null;modern:boolean;verified:boolean}>(`SELECT day_start,day_end,last_timestamp,
                (${MODERN_METADATA_SQL()}) AS modern,
                CASE WHEN ${MODERN_METADATA_SQL()}
                    THEN public.verify_compact_day_metadata(site_id,day_start,false) ELSE true END AS verified
                FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<=$2 AND ${HAS_SAMPLES_SQL()} ORDER BY day_start DESC LIMIT 2`,[siteId,asOf])).rows;
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
            await client.query('COMMIT');
            return archivedLatest;
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

    async hasData(siteId:string):Promise<boolean> {
        const result=await this.pool.query<{present:boolean}>(`SELECT EXISTS (SELECT 1 FROM "EnergyDayArchive" WHERE site_id=$1 AND ${HAS_SAMPLES_SQL()}) AS present`,[siteId]);
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
                AND NOT (day_start >= $2 AND day_end <= $3 AND metadata_checksum IS NOT NULL) AND ${HAS_SAMPLES_SQL()} ORDER BY day_start`,[siteId,start,end]);
            const summaries=(await client.query<SummaryRecord>(`SELECT s.* FROM "EnergyDaySummary" s JOIN "EnergyDayArchive" a USING (site_id,day_start,revision)
                WHERE a.site_id=$1 AND a.day_start<$3 AND a.day_end>$2 ORDER BY s.day_start,s.tariff_id,s.tariff_schedule_id NULLS FIRST`,[siteId,start,end])).rows;
            const parts=partial.rows.map(a=>detailDay(a,summaries));
            const fullDays=full.rows.map(a=>({siteId:a.site_id,start:new Date(a.day_start),end:new Date(a.day_end),attributionComplete:a.attribution_complete,
                sampleCount:a.sample_count,first:new Date(a.first_timestamp??NaN),last:new Date(a.last_timestamp??NaN),
                maxInteriorGapMs:a.max_interior_gap_ms??NaN,checksum:a.metadata_checksum??'',checksumVersion:a.metadata_version,summaries:summaries.filter(s=>s.revision===a.revision).map(summary),
                ...(a.metadata_version===3&&a.attribution?{attribution:a.attribution}:{})}));
            if (full.rows.some(a=>a.format_version!==1&&a.format_version!==2)) throw new Error('Unsupported archive version');
            await client.query('COMMIT');
            return {timezone:site.rows[0]?.timezone??null,fullDays,detail:{raw:[],days:parts}};
        } catch (error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
    }

    async readScalarSnapshot(siteId:string,start:Date,end:Date,mode:{billing:boolean;coverage:boolean}):Promise<ScalarHistorySnapshot> {
        if(!siteId || !Number.isSafeInteger(+start)||!Number.isSafeInteger(+end)||+end-+start>366*86400000) throw new Error('History window invalid or exceeds 366 days');
        if(start>=end) return {timezone:null,aggregates:[],coverage:[],detail:{raw:[],days:[]}};
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
            const site=await client.query<{timezone:string;has_detail:boolean;verified:boolean;attribution_complete:boolean}>(`SELECT timezone,
                EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start<$3 AND a.day_end>$2
                    AND NOT(a.day_start >= $2 AND a.day_end <= $3 AND ${MODERN_METADATA_SQL('a.')}) AND ${HAS_SAMPLES_SQL('a.')}) AS has_detail,
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
                ${SETTLED_ARCHIVE_DAY_SQL} AS settled,(a.metadata_version=3 AND a.status='open') AS is_open,a.fetched_at FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND a.day_start >= $2 AND a.day_end <= $3
                AND ${MODERN_METADATA_SQL('a.')}`;
            if(mode.billing) {
                const result=await client.query<CycleAggregateRow>(`WITH eligible AS MATERIALIZED (${eligible})
                    SELECT s.day_start AS day,s.tariff_id,s.tariff_schedule_id,s.load_power,s.solar_power,s.grid_power,s.battery_power
                    FROM "EnergyDaySummary" s JOIN eligible a USING(site_id,day_start,revision) ORDER BY day,tariff_id,tariff_schedule_id`,[siteId,start,end]);
                aggregates.push(...result.rows.map(r=>({...r,day:new Date(r.day),tariff_id:Number(r.tariff_id),tariff_schedule_id:r.tariff_schedule_id===null?null:Number(r.tariff_schedule_id),
                    load_power:Number(r.load_power),solar_power:Number(r.solar_power),grid_power:Number(r.grid_power),battery_power:Number(r.battery_power)})));
            }
            if(mode.coverage && timezone) {
                const result=await client.query<{key:string;count:number;first:Date;last:Date;gap:number;settled:boolean;is_open:boolean;fetched_at:Date|null}>(`WITH eligible AS MATERIALIZED (${eligible})
                    SELECT to_char(day_start AT TIME ZONE $4::text,'YYYY-MM-DD') AS key,sample_count AS count,
                        first_timestamp AS first,last_timestamp AS last,max_interior_gap_ms AS gap,settled,is_open,fetched_at FROM eligible ORDER BY day_start`,[siteId,start,end,timezone]);
                coverage.push(...result.rows.map(r=>({localDayKey:r.key,count:r.count,first:new Date(r.first),last:new Date(r.last),maxInteriorGapMs:r.gap,archived:r.settled,
                    ...(r.is_open?{open:true}:{}),...(r.fetched_at?{fetchedAt:new Date(r.fetched_at)}:{})})));
            }
            const partial=site.rows[0]?.has_detail?await client.query<DetailArchiveRecord>(`SELECT ${detailColumns} FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start<$3 AND day_end>$2
                AND NOT (day_start >= $2 AND day_end <= $3 AND ${MODERN_METADATA_SQL()}) AND ${HAS_SAMPLES_SQL()} ORDER BY day_start`,[siteId,start,end]):{rows:[]};
            const summaries=partial.rows.length?(await client.query<SummaryRecord>(`SELECT s.* FROM "EnergyDaySummary" s JOIN "EnergyDayArchive" a USING(site_id,day_start,revision)
                WHERE a.site_id=$1 AND a.day_start<$3 AND a.day_end>$2 AND NOT (a.day_start >= $2 AND a.day_end <= $3 AND ${MODERN_METADATA_SQL('a.')})
                ORDER BY s.day_start,s.tariff_id,s.tariff_schedule_id NULLS FIRST`,[siteId,start,end])).rows:[];
            const days=partial.rows.map(a=>detailDay(a,summaries));
            await client.query('COMMIT');return {attributionComplete:site.rows[0]?.attribution_complete??true,timezone,aggregates,coverage,detail:{raw:[],days}};
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    }

    /**
     * Write one site-local day, today included, straight from a Tesla fetch as the
     * only copy (format 2: samples, plus a segment timeline from the site's current
     * tariff). No raw rows are written or read back, so it costs no read egress.
     * Tesla is the source of truth, so the record is replaced, but only by a newer
     * fetch: an older, slower response is `superseded` and changes nothing.
     */
    async writeDay(siteId:string,start:Date,samples:EnergySample[],fetchedAt:Date,now=new Date()):Promise<DayWriteResult> {
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
                // Tesla failure and changes nothing; for a day with nothing stored it is a durable check:
                // an `empty` record, whose check time (fetched_at) only moves forward.
                const kept=(await client.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2 AND ${HAS_SAMPLES_SQL()}) AS present`,[siteId,start])).rows[0].present;
                if(!kept)await client.query(`INSERT INTO "EnergyDayArchive" (site_id,day_start,day_end,revision,format_version,sample_count,expected_slots,
                        attribution_complete,metadata_version,raw_pruned,status,fetched_at)
                    VALUES ($1,$2,$3,$4,2,0,$5,false,3,false,'empty',$6)
                    ON CONFLICT (site_id,day_start) DO UPDATE SET fetched_at=EXCLUDED.fetched_at
                    WHERE "EnergyDayArchive".status='empty' AND "EnergyDayArchive".fetched_at<EXCLUDED.fetched_at`,
                [siteId,start,end,randomUUID(),Math.ceil((+end-+start)/300000),fetchedAt]);
                await client.query('COMMIT');return {status:kept?'empty':'checked-empty'};
            }
            const stored=(await client.query<{revision:string;fetched_at:Date|null;status:DayRecordStatus|null}>('SELECT revision,fetched_at,status FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2 FOR UPDATE',[siteId,start])).rows[0];
            // Samples always replace an empty record: an empty answer after they were published was a Tesla failure.
            if(stored?.fetched_at&&stored.status!=='empty'&&+fetchedAt<=+stored.fetched_at) {await client.query('COMMIT');return {status:'superseded',revision:stored.revision};}
            const sorted=samples.map(toSample).sort((a,b)=>+a.timestamp-+b.timestamp);
            const {tariffs}=await this.tariffs(client,siteId,true);
            const prepared=this.prepareSamples(siteId,timezone,start,end,sorted,tariffs,fetchedAt,now);
            const revision=await this.replaceDay(client,siteId,start,end,sorted.length,prepared,true);
            await client.query('COMMIT');
            return {status:'written',revision,attributionComplete:prepared.attributionComplete,dayStatus:prepared.record!.status};
        } catch(error) {await client.query('ROLLBACK');throw error;}
        finally {client.release(this.transactionTimeoutMs!==undefined);}
    }

    /** A day record's status (null for v1, `empty` for a day Tesla answered with no samples) and fetch time, for deciding whether Tesla's answer for it is final. */
    async getDayRecordState(siteId:string,start:Date):Promise<{status:DayRecordStatus|null;fetchedAt:Date|null}|null> {
        const row=(await this.pool.query<{status:DayRecordStatus|null;fetched_at:Date|null}>('SELECT status,fetched_at FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',[siteId,start])).rows[0];
        return row?{status:row.status,fetchedAt:row.fetched_at}:null;
    }

    /**
     * Days neither a backfill nor import planning need fetch again: `empty` records
     * whose (latest) empty answer was requested after the day ended, older than the
     * gap-heal window (the age rule that makes a short day `gapped`).
     * A day with no record was never answered (or its fetch failed) and is fetched;
     * inside the window an empty day is retried like an `open` one.
     */
    async getSettledEmptyDays(siteId:string,from:Date,before:Date,now:Date):Promise<Date[]> {
        return (await this.getEmptyDays(siteId,from,before,now)).filter(d=>d.settled).map(d=>d.dayStart);
    }

    /**
     * Every empty day record starting in [from, before) with its check time, and whether
     * that answer is final (`getSettledEmptyDays`'s rule), so planning can skip settled
     * days and rotate retries of the rest by when they were last checked.
     */
    async getEmptyDays(siteId:string,from:Date,before:Date,now:Date):Promise<EmptyDayState[]> {
        const rows=(await this.pool.query<{day_start:Date;fetched_at:Date;settled:boolean}>(`SELECT a.day_start,a.fetched_at,
            (a.fetched_at >= a.day_end AND a.day_end < $4::timestamptz - make_interval(days => $5)) AS settled FROM "EnergyDayArchive" a
            WHERE a.site_id=$1 AND a.day_start >= $2 AND a.day_start < $3 AND a.status='empty'
            ORDER BY a.day_start`,[siteId,from,before,now,DAY_GAP_HEAL_DAYS])).rows;
        return rows.map(r=>({dayStart:new Date(r.day_start),fetchedAt:new Date(r.fetched_at),settled:r.settled}));
    }

    /**
     * Re-key every stored day of a site to a new timezone in one transaction, so old
     * and new local-day partitions never coexist and no Tesla request is needed
     * (tokenless sites included). Every record's samples are decoded (verified as
     * recovery does) and regrouped by the new local midnight; each new day becomes a
     * v2 record, segments from the current tariff under the new timezone,
     * `fetched_at` its oldest source's. Empty records are dropped. Preview does the
     * same work and rolls back.
     */
    async rebuildTimezone(siteId:string,timezone:string,{apply,now}:{apply:boolean;now:Date}):Promise<TimezoneRebuildResult> {
        if(!siteId?.trim()||siteId.length>200||!Number.isSafeInteger(+now))throw new Error('Invalid timezone rebuild request');
        new Intl.DateTimeFormat('en-US',{timeZone:timezone});
        const client=await this.pool.connect();
        try {
            await beginTransaction(client,'ISOLATION LEVEL READ COMMITTED');
            await this.boundTransaction(client);
            await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'");
            if(apply)await this.mutationGuard?.(client);
            if(!await this.claimMutation(client,siteId)) {await client.query('ROLLBACK');return {status:'busy'};}
            const from=(await client.query<{timezone:string}>('SELECT timezone FROM "Site" WHERE id=$1 FOR UPDATE',[siteId])).rows[0]?.timezone;
            if(!from)throw new Error('Site not found');
            if(from===timezone) {await client.query('COMMIT');return {status:'unchanged',from};}
            const stored=(await client.query<ArchiveRecord&{created_at:Date;summaries:SummaryRecord[]}>(`SELECT a.*,COALESCE((SELECT json_agg(x) FROM "EnergyDaySummary" x
                WHERE x.site_id=a.site_id AND x.day_start=a.day_start AND x.revision=a.revision),'[]') AS summaries
                FROM "EnergyDayArchive" a WHERE a.site_id=$1 AND ${HAS_SAMPLES_SQL('a.')} ORDER BY a.day_start`,[siteId])).rows;
            const days=new Map<number,{rows:EnergyData[];fetchedAt:Date}>();
            for(const archive of stored) {
                const fetchedAt=new Date(archive.fetched_at??archive.created_at);
                for(const row of recoverVerifiedSamples(archive,archive.summaries.map(summary))) {
                    const key=+getSiteMidnight(row.timestamp,timezone);
                    const day=days.get(key);
                    if(!day)days.set(key,{rows:[row],fetchedAt});
                    else {day.rows.push(row);if(fetchedAt<day.fetchedAt)day.fetchedAt=fetchedAt;}
                }
            }
            const deleted=(await client.query<{empty:boolean}>(`DELETE FROM "EnergyDayArchive" WHERE site_id=$1 RETURNING status IS NOT DISTINCT FROM 'empty' AS empty`,[siteId])).rows;
            const droppedEmptyDays=deleted.filter(r=>r.empty).length,sourceDays=deleted.length-droppedEmptyDays;
            // With no archive left the timezone trigger allows the change.
            await client.query('UPDATE "Site" SET timezone=$2 WHERE id=$1',[siteId,timezone]);
            const starts=[...days.keys()].sort((a,b)=>a-b).map(key=>new Date(key));
            const ends=starts.map(start=>addDaysInSiteTimezone(start,1,timezone));
            const {tariffs}=await this.tariffs(client,siteId,true);
            let records=0;
            for(let i=0;i<starts.length;i++) {
                const day=days.get(+starts[i])!;
                const samples=day.rows.map(toSample).sort((a,b)=>+a.timestamp-+b.timestamp);
                if(samples.some(r=>(+r.timestamp-+starts[i])%300000))throw new Error('Samples off the 5-minute grid in the new timezone');
                await this.replaceDay(client,siteId,starts[i],ends[i],samples.length,this.prepareSamples(siteId,timezone,starts[i],ends[i],samples,tariffs,day.fetchedAt,now),true);
                records++;
            }
            await client.query(apply?'COMMIT':'ROLLBACK');
            return {status:apply?'rebuilt':'previewed',from,sourceDays,records,droppedEmptyDays};
        } catch(error) {await client.query('ROLLBACK');throw error;}
        finally {client.release(this.transactionTimeoutMs!==undefined);}
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
