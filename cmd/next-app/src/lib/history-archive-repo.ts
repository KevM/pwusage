import type {Pool,PoolClient} from 'pg';
import {CompactHistoryStore} from './prototypes/compact-history-store';
import {addDaysInSiteTimezone,getSiteMidnight} from './date-utils';
import {ArchiveControlChangedError} from './history-archive-service';
import type {ArchiveCandidate,ArchiveControl,ArchiveDayStatus,ArchiveJobRepo,ArchiveReport} from './history-archive-service';

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
    async next(trim:boolean,retentionDays:number,now:Date,preferRetry=false):Promise<ArchiveCandidate|null> {
        const eligible=`e.timestamp < (((($3::timestamptz AT TIME ZONE s.timezone)::date - GREATEST($2::int,2))::timestamp) AT TIME ZONE s.timezone)
            AND (s.from_date IS NULL OR e.timestamp >= (s.from_date::timestamp AT TIME ZONE s.timezone))
            AND (s.before_date IS NULL OR e.timestamp < (s.before_date::timestamp AT TIME ZONE s.timezone))
            AND ($1::boolean OR NOT EXISTS (SELECT 1 FROM "EnergyDayArchive" a
                WHERE a.site_id=s.id AND e.timestamp>=a.day_start AND e.timestamp<a.day_end
                AND a.metadata_version=2 AND a.metadata_checksum IS NOT NULL AND a.payload_checksum IS NOT NULL))`;
        const result=await this.connection().query<{site_id:string;timezone:string;timestamp:Date}>(`
            WITH sites AS MATERIALIZED (SELECT s.id,s.timezone,h.from_date,h.before_date FROM "Site" s
                CROSS JOIN "HistoryArchiveControl" h WHERE h.id=true AND s.user_id IS NOT NULL AND s.id=ANY(h.site_ids)),
            candidates AS (
                SELECT s.id AS site_id,s.timezone,c.timestamp,false AS retry,NULL::timestamptz AS retry_at FROM sites s
                CROSS JOIN LATERAL (SELECT e.timestamp FROM "EnergyData" e WHERE e.site_id=s.id AND ${eligible}
                    AND NOT EXISTS (SELECT 1 FROM "HistoryArchiveRetry" r WHERE r.site_id=s.id
                        AND e.timestamp>=r.day_start AND e.timestamp<r.day_end)
                    ORDER BY e.timestamp LIMIT 1) c
                UNION ALL
                SELECT s.id AS site_id,s.timezone,c.timestamp,true AS retry,r.retry_after AS retry_at FROM sites s
                JOIN "HistoryArchiveRetry" r ON r.site_id=s.id AND r.retry_after<=$3
                CROSS JOIN LATERAL (SELECT e.timestamp FROM "EnergyData" e WHERE e.site_id=s.id
                    AND e.timestamp>=r.day_start AND e.timestamp<r.day_end AND ${eligible}
                    ORDER BY e.timestamp LIMIT 1) c
            ) SELECT site_id,timezone,timestamp FROM candidates
            ORDER BY (retry=$4::boolean) DESC,retry_at NULLS LAST,timestamp,site_id LIMIT 1`,[trim,retentionDays,now,preferRetry]);
        const row=result.rows[0];if(!row)return null;
        const start=getSiteMidnight(row.timestamp,row.timezone);
        return {siteId:row.site_id,timezone:row.timezone,start,end:addDaysInSiteTimezone(start,1,row.timezone)};
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
