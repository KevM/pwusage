import type {Pool,PoolClient} from 'pg';
import {CompactHistoryStore} from './prototypes/compact-history-store';
import {addDaysInSiteTimezone,getSiteMidnight} from './date-utils';
import {ArchiveControlChangedError} from './history-archive-service';
import type {ArchiveCandidate,ArchiveControl,ArchiveDayStatus,ArchiveJobRepo,ArchiveReport,HealControl} from './history-archive-service';

/** Internal cron/operator control only. No user-facing mutation API. */
export class HistoryArchiveRepo implements ArchiveJobRepo {
    private client:PoolClient|undefined;
    private clientFailure:Error|undefined;
    private readonly onClientError=(error:Error):void=>{this.clientFailure=error;};
    constructor(private readonly pool:Pool) {}
    private connection():PoolClient {
        if(this.clientFailure)throw new Error('Archive claim connection failed');
        if(!this.client)throw new Error('Archive job claim required');return this.client;
    }
    async claim():Promise<boolean> {
        if(this.client)throw new Error('Archive job already claimed');
        const client=await this.pool.connect();
        try {
            client.on('error',this.onClientError);this.clientFailure=undefined;
            await client.query('BEGIN');
            await client.query("SET LOCAL statement_timeout='15s'");
            await client.query("SET LOCAL transaction_timeout='60s'");
            // Freshly truncated or never-analyzed tables inflate next()'s estimate past
            // jit_above_cost; compiling a tiny lookup has stalled it past statement_timeout.
            await client.query("SET LOCAL jit=off");
            const result=await client.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended('daily-history-archive-job',0)) AS acquired");
            if(!result.rows[0].acquired) {await client.query('ROLLBACK');client.off('error',this.onClientError);client.release(true);return false;}
            this.client=client;return true;
        } catch(error) {client.off('error',this.onClientError);client.release(true);throw error;}
    }
    async release():Promise<void> {
        const client=this.client;this.client=undefined;
        if(!client)return;
        try {await client.query('ROLLBACK');}
        finally {client.off('error',this.onClientError);client.release(true);}
    }
    async control():Promise<ArchiveControl> {
        const result=await this.connection().query<ArchiveControl>('SELECT paused,trim,xmin::text AS revision FROM "HistoryArchiveControl" WHERE id=true');
        if(!result.rows[0])throw new Error('Missing archive control');return result.rows[0];
    }
    /**
     * Control for archiving one healed day outside the job claim, or null when the
     * job is paused or the day is outside its cohort (as in `next`). `trimSite` says
     * whether trim mode covers this day (listed site, inside the date bounds).
     * The guarded finalize/trim still re-check this revision in their transaction.
     */
    async healControl(day:ArchiveCandidate):Promise<HealControl|null> {
        const inBounds=`(h.from_date IS NULL OR $2::timestamptz >= (h.from_date::timestamp AT TIME ZONE s.timezone))
                AND (h.before_date IS NULL OR $2::timestamptz < (h.before_date::timestamp AT TIME ZONE s.timezone))`;
        const result=await this.pool.query<HealControl>(`SELECT h.paused,h.trim,h.xmin::text AS revision,
                (h.trim AND s.id=ANY(h.site_ids) AND ${inBounds}) AS "trimSite"
            FROM "HistoryArchiveControl" h JOIN "Site" s ON s.id=$1 AND s.user_id IS NOT NULL
            WHERE h.id=true AND NOT h.paused AND (h.archive_all OR (s.id=ANY(h.site_ids) AND ${inBounds}))`,[day.siteId,day.start]);
        return result.rows[0]??null;
    }
    /**
     * The oldest day to work on: an unarchived day past the archive-after cutoff for
     * any site in the cohort (archive_all, or listed and inside the date bounds), or,
     * in trim mode, a listed in-bound day past retention that still has raw rows.
     * `trim` on the result marks the latter. Every candidate is past the
     * archive-after cutoff: a day is archived before it may be trimmed.
     *
     * Walks each site's raw history a day at a time (one index seek per day) rather
     * than testing every raw row against the archive: per-row probing took over a
     * minute on production once most raw days were already archived.
     */
    async next(retentionDays:number,archiveAfterDays:number,now:Date,preferRetry=false):Promise<ArchiveCandidate|null> {
        const before=(days:string,ts:string)=>`${ts} < (((($3::timestamptz AT TIME ZONE s.timezone)::date - GREATEST(${days}::int,2))::timestamp) AT TIME ZONE s.timezone)`;
        const inBounds=(ts:string)=>`(s.from_date IS NULL OR ${ts} >= (s.from_date::timestamp AT TIME ZONE s.timezone))
            AND (s.before_date IS NULL OR ${ts} < (s.before_date::timestamp AT TIME ZONE s.timezone))`;
        const trimDay=(ts:string)=>`(s.trim_site AND ${inBounds(ts)} AND ${before('$1',ts)} AND ${before('$2',ts)})`;
        // Archive days start at site midnight, so the containing day is found within a two-day index range.
        const archived=(ts:string)=>`EXISTS (SELECT 1 FROM "EnergyDayArchive" a WHERE a.site_id=s.id
            AND a.day_start<=${ts} AND a.day_start>${ts}-interval '2 days' AND ${ts}<a.day_end
            AND a.metadata_version IN (2,3) AND a.metadata_checksum IS NOT NULL AND a.payload_checksum IS NOT NULL)`;
        const eligible=(ts:string)=>`(${trimDay(ts)} OR ((s.archive_all OR (s.listed AND ${inBounds(ts)})) AND ${before('$2',ts)} AND NOT ${archived(ts)}))`;
        const retried=(ts:string)=>`EXISTS (SELECT 1 FROM "HistoryArchiveRetry" r WHERE r.site_id=s.id AND ${ts}>=r.day_start AND ${ts}<r.day_end)`;
        const nextMidnight=`((((s.ts AT TIME ZONE s.timezone)::date + 1)::timestamp) AT TIME ZONE s.timezone)`;
        const result=await this.connection().query<{site_id:string;timezone:string;timestamp:Date;trim:boolean}>(`
            WITH RECURSIVE sites AS MATERIALIZED (SELECT s.id,s.timezone,h.from_date,h.before_date,h.archive_all,
                    s.id=ANY(h.site_ids) AS listed,(h.trim AND s.id=ANY(h.site_ids)) AS trim_site
                FROM "Site" s CROSS JOIN "HistoryArchiveControl" h
                WHERE h.id=true AND s.user_id IS NOT NULL AND (h.archive_all OR s.id=ANY(h.site_ids))),
            walk AS (
                SELECT s.*,(SELECT min(e.timestamp) FROM "EnergyData" e WHERE e.site_id=s.id) AS ts FROM sites s
                UNION ALL
                SELECT s.id,s.timezone,s.from_date,s.before_date,s.archive_all,s.listed,s.trim_site,
                    (SELECT min(e.timestamp) FROM "EnergyData" e WHERE e.site_id=s.id AND e.timestamp>=${nextMidnight})
                FROM walk s
                WHERE s.ts IS NOT NULL AND ${before('$2','s.ts')}
                    AND NOT (${eligible('s.ts')} AND NOT ${retried('s.ts')})),
            candidates AS (
                SELECT s.id AS site_id,s.timezone,s.ts AS timestamp,${trimDay('s.ts')} AS trim,false AS retry,NULL::timestamptz AS retry_at FROM walk s
                WHERE s.ts IS NOT NULL AND ${eligible('s.ts')} AND NOT ${retried('s.ts')}
                UNION ALL
                SELECT s.id AS site_id,s.timezone,c.timestamp,c.trim,true AS retry,r.retry_after AS retry_at FROM sites s
                JOIN "HistoryArchiveRetry" r ON r.site_id=s.id AND r.retry_after<=$3
                CROSS JOIN LATERAL (SELECT e.timestamp,${trimDay('e.timestamp')} AS trim FROM "EnergyData" e WHERE e.site_id=s.id
                    AND e.timestamp>=r.day_start AND e.timestamp<r.day_end AND ${eligible('e.timestamp')}
                    ORDER BY e.timestamp LIMIT 1) c
            ) SELECT site_id,timezone,timestamp,trim FROM candidates
            ORDER BY (retry=$4::boolean) DESC,retry_at NULLS LAST,timestamp,site_id LIMIT 1`,[retentionDays,archiveAfterDays,now,preferRetry]);
        const row=result.rows[0];if(!row)return null;
        const start=getSiteMidnight(row.timestamp,row.timezone);
        return {siteId:row.site_id,timezone:row.timezone,start,end:addDaysInSiteTimezone(start,1,row.timezone),trim:row.trim};
    }
    /** Conservative response admission estimate; not provider wire-byte accounting. */
    async estimate(day:ArchiveCandidate):Promise<number> {
        const result=await this.connection().query<{samples:number;bytes:string}>(`
            WITH raw AS MATERIALIZED (SELECT e.* FROM "EnergyData" e
                WHERE site_id=$1 AND timestamp >= $2 AND timestamp < $3 LIMIT 4097),
            sizes AS (
                SELECT COALESCE(sum(octet_length(row_to_json(r)::text)),0) AS n FROM raw r
                UNION ALL SELECT COALESCE(sum(octet_length(row_to_json(a)::text)),0) FROM "EnergyDayArchive" a WHERE site_id=$1 AND day_start=$2
                UNION ALL SELECT COALESCE(sum(octet_length(row_to_json(s)::text)),0) FROM "EnergyDaySummary" s WHERE site_id=$1 AND day_start=$2
                UNION ALL SELECT COALESCE(sum(octet_length(row_to_json(t)::text)),0) FROM "Tariff" t WHERE site_id=$1
                UNION ALL SELECT COALESCE(sum(octet_length(row_to_json(s)::text)),0) FROM "TariffSeason" s JOIN "Tariff" t ON t.id=s.tariff_id WHERE t.site_id=$1
                UNION ALL SELECT COALESCE(sum(octet_length(row_to_json(p)::text)),0) FROM "TariffSchedule" p JOIN "TariffSeason" s ON s.id=p.season_id JOIN "Tariff" t ON t.id=s.tariff_id WHERE t.site_id=$1
            ) SELECT (SELECT count(*)::int FROM raw) AS samples,sum(n)::text AS bytes FROM sizes`,[day.siteId,day.start,day.end]);
        const row=result.rows[0];
        if(row.samples>4096)return 128*1024*1024;
        // Includes new compressed payload, old/new summaries and framing; reserves trim
        // even in archive-only mode. Source changes can grow transfer after preflight.
        return Math.ceil(65536+2*Number(row.bytes)+row.samples*2048);
    }
    private guardedStore(control:ArchiveControl):CompactHistoryStore {
        return new CompactHistoryStore(this.pool,15000,async client=>{
            // Serialize an admitted phase with ALL control edits, including cohort
            // and date bounds. xmin catches pause/resume and ABA changes too.
            const result=await client.query<ArchiveControl>('SELECT paused,trim,xmin::text AS revision FROM "HistoryArchiveControl" WHERE id=true FOR SHARE');
            const current=result.rows[0];
            if(!current||current.paused||current.trim!==control.trim||current.revision!==control.revision)throw new ArchiveControlChangedError();
        });
    }
    finalize(day:ArchiveCandidate,now:Date,control:ArchiveControl) {return this.guardedStore(control).finalizeDay(day.siteId,day.start,now);}
    trim(day:ArchiveCandidate,revision:string,now:Date,control:ArchiveControl) {return this.guardedStore(control).trimDay(day.siteId,day.start,revision,now);}
    async retry(day:ArchiveCandidate,reason:ArchiveDayStatus,now:Date):Promise<void> {
        await this.pool.query(`INSERT INTO "HistoryArchiveRetry" (site_id,day_start,day_end,attempts,retry_after,reason)
            VALUES ($1,$2,$3,1,$5::timestamptz+interval '15 minutes',$4)
            ON CONFLICT (site_id,day_start) DO UPDATE SET day_end=EXCLUDED.day_end,
                attempts=LEAST("HistoryArchiveRetry".attempts+1,30),reason=EXCLUDED.reason,
                retry_after=$5::timestamptz + LEAST(86400,900*power(2,LEAST("HistoryArchiveRetry".attempts,7))) * interval '1 second'`,
        [day.siteId,day.start,day.end,reason,now]);
    }
    async clearRetry(day:ArchiveCandidate):Promise<void> {
        await this.pool.query('DELETE FROM "HistoryArchiveRetry" WHERE site_id=$1 AND day_start=$2',[day.siteId,day.start]);
    }
    async saveReport(report:ArchiveReport):Promise<void> {
        await this.pool.query('UPDATE "HistoryArchiveControl" SET last_run_at=now(),last_report=$1::jsonb WHERE id=true',[JSON.stringify(report)]);
    }
}
