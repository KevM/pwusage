import {EnergyRepo} from '../energy-repo';
import {withRawEnergyAccess,energyQueryExecutor} from '../energy-storage-access';
import {HistoryArchiveRecoveryRepo,parseRestorePlan,restoreHistoryPlan} from '../history-archive-recovery';
import {IncompleteTariffAttributionError,readBillingAvailability} from '../billing-availability';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {addDaysInSiteTimezone} from '../date-utils';
import { readFileSync, statSync } from 'node:fs';
import { CompactHistoryStore } from './compact-history-store';
import { CompactHistoryReader } from './compact-history-reader';
import {HistoryArchiveRepo} from '../history-archive-repo';
import {archiveCutoff,runHistoryArchive} from '../history-archive-service';

const socket = process.env.COMPACT_HISTORY_TEST_SOCKET;
const start = new Date('2026-01-01T06:00:00Z');
const end = new Date('2026-01-02T06:00:00Z');
const now = new Date('2026-01-03T06:00:00Z');
// Never fall back to DATABASE_URL. Integration fixtures are synthetic and disposable.
// These tests run multiple real transactions; shared CI runners can exceed
// Vitest's 5s unit-test default even when the database operations succeed.
describe.skipIf(!socket)('compact persistence on private local PostgreSQL', { timeout: 30000 }, () => {
    let pool: Pool;
    let admin: Pool;
    const database = `compact_history_test_${randomUUID().replaceAll('-','')}`;
    let store: CompactHistoryStore;
    beforeAll(async () => {
        if (!socket || !/^\/(?:private\/)?tmp\/compact-energy-pg-[A-Za-z0-9-]+$/.test(socket)
            || (statSync(socket).mode & 0o777) !== 0o700) throw new Error('Unsafe integration socket');
        admin = new Pool({ host: socket, port: 55439, database: 'postgres', user: process.env.USER });
        await admin.query(`CREATE DATABASE ${database}`);
        pool = new Pool({ host: socket, port: 55439, database, user: process.env.USER, max: 5 });
        await pool.query(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
            END $$;
            CREATE TABLE "Site" (id text PRIMARY KEY, timezone text NOT NULL);
            CREATE TABLE "Tariff" (id int PRIMARY KEY, site_id text, name text, updated timestamptz);
            CREATE TABLE "TariffSeason" (id int PRIMARY KEY, tariff_id int, name text, from_month int, from_day int,
                to_month int, to_day int, buy_rate float8, sell_rate float8);
            CREATE TABLE "TariffSchedule" (id int PRIMARY KEY, season_id int, name text, buy_rate float8, sell_rate float8,
                from_day_of_week int, to_day_of_week int, from_hour int, to_hour int, from_minute int, to_minute int);
            CREATE TABLE "LoadTag" (end_time timestamptz);
            CREATE TABLE "EnergyData" (site_id text, timestamp timestamptz, tariff_id int, tariff_schedule_id int,
                load_power float8, solar_power float8, grid_power float8, battery_power float8, battery_soc float8,
                PRIMARY KEY (site_id,timestamp));
            INSERT INTO "Site" VALUES ('site','America/Chicago'),('other','America/Chicago');
            INSERT INTO "Tariff" VALUES (1,'site','Utility',now());
            INSERT INTO "TariffSeason" VALUES (1,1,'All',1,1,12,31,.3,.04);
            INSERT INTO "TariffSchedule" VALUES (2,1,'Standard',.3,.04,0,6,0,24,0,0);`);
        await pool.query(readFileSync(new URL('../../../db-migrations/20261007093013_compact_energy_history.sql', import.meta.url), 'utf8'));
        await pool.query(readFileSync(new URL('../../../db-migrations/20261007094607_compact_energy_day_metadata.sql', import.meta.url), 'utf8'));
        await pool.query(readFileSync(new URL('../../../db-migrations/20261007122207_compact_energy_scalar_reads.sql',import.meta.url),'utf8'));
        await pool.query(readFileSync(new URL('../../../db-migrations/20261007132054_compact_energy_latest_projection.sql',import.meta.url),'utf8'));
        await pool.query(readFileSync(new URL('../../../db-migrations/20261007134255_compact_energy_payload_integrity.sql',import.meta.url),'utf8'));
        await pool.query(readFileSync(new URL('../../../db-migrations/20261007144600_compact_energy_trim_recovery.sql',import.meta.url),'utf8'));
        await pool.query(readFileSync(new URL('../../../db-migrations/20261007190945_history_archive_job.sql',import.meta.url),'utf8'));
        await pool.query("ALTER TABLE \"Site\" ADD COLUMN user_id text DEFAULT 'owner'");
        store = new CompactHistoryStore(pool,15000,async client=>{await client.query('SELECT 1');});
    });
    beforeEach(async () => {
        await pool.query('TRUNCATE "EnergyData", "LoadTag", "EnergyDayArchive", "HistoryArchiveRetry" CASCADE');
        await pool.query(`UPDATE "HistoryArchiveControl" SET paused=true,trim=false,last_report=null,site_ids=ARRAY['site'],from_date=null,before_date=null`);
        await pool.query(`UPDATE "Site" SET timezone='America/Chicago' WHERE id='site'`);
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,20,3,10,-2,null),('site',$2,1,2,20,3,-5,-2,50)`, [start, new Date(+start+300000)]);
    });
    afterAll(async () => {
        await pool?.end();
        if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS ${database}`); } finally { await admin.end(); } }
    });
    const jobOptions={now:new Date('2026-01-10T12:00:00Z'),retentionDays:3,maxDays:2,maxTimeMs:30000,maxEstimatedBytes:4*1024*1024,readsEnabled:true};
    it('raw and compact billing history agree on local days across DST in another session timezone', async () => {
        const from = new Date('2026-11-01T05:00:00Z');
        const until = new Date('2026-11-02T06:10:00Z');
        await pool.query(`INSERT INTO "EnergyData"
            SELECT 'site', time, 1, 2, 20, 3, 10, -2, null
            FROM generate_series($1::timestamptz, $2::timestamptz - interval '5 minutes', interval '5 minutes') time`, [from, until]);
        const raw = await withRawEnergyAccess(['site'], 'read', async () => {
            await energyQueryExecutor().query("SET LOCAL TIME ZONE 'Pacific/Auckland'");
            return new EnergyRepo().getCycleAggregatesAndCoverage('site', from, until, 'America/Chicago');
        }, pool);
        expect(raw.kind).toBe('raw');
        if (raw.kind !== 'raw') throw new Error('Expected unpruned synthetic history');
        const compact = await new CompactHistoryReader(store, 'America/Chicago')
            .getCycleAggregatesAndCoverage('site', from, until, 'America/Chicago');
        expect(raw.value).toEqual(compact);
        expect(raw.value.aggregates.map(row => [row.day.toISOString(), row.grid_power])).toEqual([
            ['2026-11-01T05:00:00.000Z', 3000], ['2026-11-02T06:00:00.000Z', 20],
        ]);
        expect(raw.value.coverage.map(row => row.count)).toEqual([300, 2]);
    });

    it('archives and trims exact gaps through the daily job, preserving tags and tariffs',async()=>{
        await pool.query('INSERT INTO "LoadTag" VALUES ($1)',[end]);
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true');
        const original=(await store.readVerificationSnapshot('site',start,end)).raw;
        const tariffs=(await pool.query('SELECT * FROM "TariffSchedule"')).rows;
        const reader=new CompactHistoryReader(store,'America/Chicago');
        const coverage=await reader.getDailyCoverage('site',start,end,'America/Chicago');
        const totals=await reader.getCycleAggregates('site',start,end);
        const report=await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions);
        expect(report.days).toEqual([{siteId:'site',start:start.toISOString(),status:'trimmed',samples:2}]);
        expect(report.stopped).toBe('caught-up');
        expect(await reader.getRawEnergyData('site',start,end)).toEqual(original);
        // Same samples; the trimmed day is now also flagged as a settled archive day.
        expect(await reader.getDailyCoverage('site',start,end,'America/Chicago')).toEqual(coverage.map(c=>({...c,archived:true})));
        expect(await reader.getCycleAggregates('site',start,end)).toEqual(totals);
        expect((await pool.query('SELECT count(*)::int AS n FROM "LoadTag"')).rows[0].n).toBe(1);
        expect((await pool.query('SELECT * FROM "TariffSchedule"')).rows).toEqual(tariffs);
        expect((await pool.query('SELECT last_report FROM "HistoryArchiveControl"')).rows[0].last_report).toEqual(report);
        const revision=(await pool.query('SELECT revision FROM "EnergyDayArchive"')).rows[0].revision;
        await store.restoreDay('site',start,revision);
        expect((await store.readVerificationSnapshot('site',start,end)).raw).toEqual(original);
    });
    const fillDay=()=>pool.query(`INSERT INTO "EnergyData" SELECT 'site',t,1,2,20,3,10,-2,null
        FROM generate_series($1::timestamptz,$2::timestamptz-interval '5 minutes',interval '5 minutes') t ON CONFLICT DO NOTHING`,[start,end]);
    it('flags only settled archive days in scalar coverage',async()=>{
        const reader=new CompactHistoryReader(store,'America/Chicago');
        const day=async()=>(await reader.getDailyCoverage('site',start,end,'America/Chicago'))[0];
        const partial=await store.finalizeDay('site',start,now);
        // 2 of 288 slots with raw still kept: the raw coverage audit still decides.
        expect(await day()).toMatchObject({count:2,archived:false});
        await store.trimDay('site',start,partial.revision!,new Date('2026-01-05'));
        // Pruned: the archive is the only copy, so a re-fetch would only churn it.
        expect(await day()).toMatchObject({count:2,archived:true});
    });
    it('flags a complete unpruned archive day as settled',async()=>{
        await fillDay();
        await store.finalizeDay('site',start,now);
        expect((await new CompactHistoryReader(store,'America/Chicago').getDailyCoverage('site',start,end,'America/Chicago'))[0])
            .toMatchObject({count:288,archived:true});
    });
    it('counts settled archive days as fully stored slots for the gap-heal pre-check',async()=>{
        const later=addDaysInSiteTimezone(end,1,'America/Chicago');
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,20,3,10,-2,null)`,[end]);
        const count=async()=>(await new EnergyRepo().countAlignedSamples([{siteId:'site',start,end:later}],pool)).get('site');
        expect(await count()).toBe(3);
        const finalized=await store.finalizeDay('site',start,now);
        expect(await count()).toBe(3);
        await store.trimDay('site',start,finalized.revision!,new Date('2026-01-05'));
        expect(await count()).toBe(288+1);
    });
    it('reads the heal control only for cohort days inside the configured bounds',async()=>{
        const repo=new HistoryArchiveRepo(pool);
        const day={siteId:'site',start,end,timezone:'America/Chicago'};
        expect(await repo.healControl(day)).toBeNull();
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true');
        expect(await repo.healControl(day)).toMatchObject({paused:false,trim:true,revision:expect.any(String)});
        await pool.query(`UPDATE "HistoryArchiveControl" SET from_date='2025-12-31',before_date='2026-01-02'`);
        expect(await repo.healControl(day)).not.toBeNull();
        await pool.query(`UPDATE "HistoryArchiveControl" SET from_date='2026-01-02',before_date='2026-01-03'`);
        expect(await repo.healControl(day)).toBeNull();
        await pool.query(`UPDATE "HistoryArchiveControl" SET from_date='2025-12-01',before_date='2026-01-01'`);
        expect(await repo.healControl(day)).toBeNull();
        await pool.query(`UPDATE "HistoryArchiveControl" SET from_date=null,before_date=null,site_ids=ARRAY['other']`);
        expect(await repo.healControl(day)).toBeNull();
    });
    it('finalizes and trims a healed day through the heal control without the job claim',async()=>{
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true');
        const {archiveHealedDays}=await import('../healed-day-archive');
        const result=await archiveHealedDays({id:'site',timezone:'America/Chicago'},[{start,end}],jobOptions.now,
            {repo:new HistoryArchiveRepo(pool),env:{DATA_RETENTION_DAYS:'3',COMPACT_HISTORY_READS_ENABLED:'true'} as unknown as NodeJS.ProcessEnv});
        expect(result).toEqual([{start:start.toISOString(),status:'trimmed'}]);
        expect((await pool.query('SELECT raw_pruned FROM "EnergyDayArchive"')).rows).toEqual([{raw_pruned:true}]);
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(0);
    });
    it('rejects a replaced control revision inside the mutation transaction',async()=>{
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true');
        const repo=new HistoryArchiveRepo(pool);await repo.claim();
        try {
            const reviewed=await repo.control();
            await pool.query("UPDATE \"HistoryArchiveControl\" SET site_ids=ARRAY['other']");
            const day={siteId:'site',start,end,timezone:'America/Chicago'};
            await expect(repo.finalize(day,jobOptions.now,reviewed)).rejects.toThrow('Archive control changed');
            expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDayArchive"')).rows[0].n).toBe(0);
            const finalized=await store.finalizeDay('site',start,jobOptions.now);
            await expect(repo.trim(day,finalized.revision!,jobOptions.now,reviewed)).rejects.toThrow('Archive control changed');
            expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
        } finally {await repo.release();}
    });
    it('refuses to trim or restore without a mutation guard',async()=>{
        const before=(await pool.query('SELECT count(*)::int AS n FROM "EnergyData" WHERE site_id=$1',['site'])).rows[0].n;
        const unguarded=new CompactHistoryStore(pool,15000);
        const finalized=await store.finalizeDay('site',start,jobOptions.now);
        await expect(unguarded.trimDay('site',start,finalized.revision!,new Date('2026-01-05')))
            .rejects.toThrow('mutation guard is required');
        await expect(unguarded.restoreDay('site',start,finalized.revision!))
            .rejects.toThrow('mutation guard is required');
        // Nothing was deleted or restored: raw is untouched and the archive is intact.
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData" WHERE site_id=$1',['site'])).rows[0].n).toBe(before);
        expect((await pool.query('SELECT raw_pruned FROM "EnergyDayArchive" WHERE site_id=$1 AND day_start=$2',['site',start])).rows[0]?.raw_pruned).toBe(false);
    });
    it('restores a pruned day before adding a late sample and can trim the rebuilt day',async()=>{
        const original=(await store.readVerificationSnapshot('site',start,end)).raw;
        const first=await store.finalizeDay('site',start,jobOptions.now);
        await store.trimDay('site',start,first.revision!,jobOptions.now);
        const added={...original[0],timestamp:new Date(+start+600000),grid_power:7};
        await store.writeEnergyDataBatch([added]);
        expect((await store.readVerificationSnapshot('site',start,end)).raw).toEqual([...original,added]);
        const rebuilt=await store.finalizeDay('site',start,jobOptions.now);
        expect(rebuilt).toMatchObject({status:'finalized',attributionComplete:true});
        expect(await store.trimDay('site',start,rebuilt.revision!,jobOptions.now)).toMatchObject({status:'trimmed',samples:3});
        expect(await new CompactHistoryReader(store,'America/Chicago').getRawEnergyData('site',start,end)).toEqual([...original,added]);
    });
    it('previews and restores reviewed pruned days only while the job is paused',async()=>{
        const original=(await store.readVerificationSnapshot('site',start,end)).raw;
        const finalized=await store.finalizeDay('site',start,jobOptions.now);
        await store.trimDay('site',start,finalized.revision!,jobOptions.now);
        const repo=new HistoryArchiveRecoveryRepo(pool);
        const plan=await repo.preview(null);
        expect(plan).toMatchObject({version:1,remainingPrunedDays:1,days:[{siteId:'site',start:start.toISOString(),revision:finalized.revision}]});
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false');
        await expect(restoreHistoryPlan(repo,parseRestorePlan(plan))).rejects.toThrow('Pause the archive job');
        expect(await repo.remaining()).toBe(1);
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=true');
        await expect(restoreHistoryPlan(repo,parseRestorePlan({...plan,days:[{...plan.days[0],revision:randomUUID()}]}))).rejects.toThrow('Reviewed archive revision changed');
        expect(await repo.remaining()).toBe(1);
        expect(await restoreHistoryPlan(repo,parseRestorePlan(plan))).toMatchObject({remainingPrunedDays:0,stopped:'complete'});
        expect((await store.readVerificationSnapshot('site',start,end)).raw).toEqual(original);
    });
    it('classifies missing pricing in scalar billing while preserving charts and integrity failures',async()=>{
        await pool.query('UPDATE "EnergyData" SET tariff_schedule_id=null');
        await store.finalizeDay('site',start,jobOptions.now);
        const reader=new CompactHistoryReader(store,'America/Chicago');
        expect(await reader.getRawEnergyData('site',start,end)).toHaveLength(2);
        await expect(reader.getCycleAggregates('site',start,end)).rejects.toBeInstanceOf(IncompleteTariffAttributionError);
        expect(await readBillingAvailability(()=>reader.getCycleAggregates('site',start,end),[])).toEqual({status:'incomplete-attribution',value:[]});
        await pool.query('UPDATE "EnergyDaySummary" SET grid_power=999');
        await expect(readBillingAvailability(()=>reader.getCycleAggregates('site',start,end),[])).rejects.toThrow('Day metadata mismatch');
    });
    it('does not let missing pricing in one day mask corrupted metadata in another',async()=>{
        await pool.query('UPDATE "EnergyData" SET tariff_schedule_id=null');
        await store.finalizeDay('site',start,jobOptions.now);
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,20,3,10,-2,null)`,[end]);
        await store.finalizeDay('site',end,jobOptions.now);
        await pool.query('UPDATE "EnergyDaySummary" SET grid_power=999 WHERE day_start=$1',[end]);
        const reader=new CompactHistoryReader(store,'America/Chicago');
        await expect(readBillingAvailability(()=>reader.getCycleAggregates('site',start,addDaysInSiteTimezone(end,1,'America/Chicago')),[])).rejects.toThrow('Day metadata mismatch');
    });
    it('does not let the first trim straddle flag-off storage selection and a raw operation',async()=>{
        const finalized=await store.finalizeDay('site',start,jobOptions.now);
        const read=await withRawEnergyAccess(['site'],'read',async()=>{
            expect(await store.trimDay('site',start,finalized.revision!,jobOptions.now)).toMatchObject({status:'busy'});
            return Number((await energyQueryExecutor().query('SELECT count(*) AS n FROM "EnergyData" WHERE site_id=$1',['site'])).rows[0].n);
        },pool);
        expect(read).toEqual({kind:'raw',value:2});
        expect(await store.trimDay('site',start,finalized.revision!,jobOptions.now)).toMatchObject({status:'trimmed'});
        for(const mode of ['read','write'] as const) {
            expect(await withRawEnergyAccess(['site'],mode,async()=>{throw new Error('Unexpected raw operation after pruning');},pool)).toEqual({kind:'compact'});
        }
    });
    it('archive-only progress skips retained modern archives on the next run',async()=>{
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false');
        expect((await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions)).days[0].status).toBe('archived');
        expect((await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions)).days).toEqual([]);
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
    });
    it('persistent backoff lets other days progress and retries after expiry',async()=>{
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true');
        await pool.query('UPDATE "EnergyData" SET tariff_schedule_id=null');
        const second=addDaysInSiteTimezone(start,1,'America/Chicago');
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,20,3,10,-2,null)`,[second]);
        const report=await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions);
        expect(report.days.map(d=>d.status)).toEqual(['incomplete-attribution','trimmed']);
        const retry=(await pool.query('SELECT attempts,reason,retry_after FROM "HistoryArchiveRetry"')).rows[0];
        expect(retry.attempts).toBe(1);expect(retry.reason).toBe('incomplete-attribution');
        const next=await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions);expect(next.days).toEqual([]);
        await pool.query('UPDATE "EnergyData" SET tariff_schedule_id=2');
        const later=await runHistoryArchive(new HistoryArchiveRepo(pool),{...jobOptions,now:new Date(+jobOptions.now+16*60000)});
        expect(later.days[0].status).toBe('trimmed');expect((await pool.query('SELECT * FROM "HistoryArchiveRetry"')).rows).toEqual([]);
    });
    it('daily retry failures cannot consume all progress slots',async()=>{
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true');
        await pool.query('UPDATE "EnergyData" SET tariff_schedule_id=null');
        const second=addDaysInSiteTimezone(start,1,'America/Chicago');
        const third=addDaysInSiteTimezone(start,2,'America/Chicago');
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,null,20,3,10,-2,null),('site',$2,1,2,20,3,10,-2,null)`,[second,third]);
        await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions);
        const daily=await runHistoryArchive(new HistoryArchiveRepo(pool),{...jobOptions,now:new Date(+jobOptions.now+86400000)});
        expect(daily.days.some(d=>d.start===third.toISOString()&&d.status==='trimmed')).toBe(true);
    });
    it('newer repaired retries progress past permanent older failures',async()=>{
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true');
        await pool.query('UPDATE "EnergyData" SET tariff_schedule_id=null');
        const second=addDaysInSiteTimezone(start,1,'America/Chicago');
        const third=addDaysInSiteTimezone(start,2,'America/Chicago');
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,null,20,3,10,-2,null),('site',$2,1,2,20,3,10,-2,null)`,[second,third]);
        for(const date of [start,second,third])await pool.query(`INSERT INTO "HistoryArchiveRetry" VALUES ('site',$1,$2,7,$3,'failed')`,[date,addDaysInSiteTimezone(date,1,'America/Chicago'),new Date(+jobOptions.now-86400000)]);
        await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions);
        const daily=await runHistoryArchive(new HistoryArchiveRepo(pool),{...jobOptions,now:new Date(+jobOptions.now+86400000)});
        expect(daily.days.some(d=>d.start===third.toISOString()&&d.status==='trimmed')).toBe(true);
    });
    it('scopes the job to explicitly selected owned sites',async()=>{
        await pool.query(`UPDATE "HistoryArchiveControl" SET paused=false,trim=true,site_ids='{}'`);
        expect((await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions)).days).toEqual([]);
        await pool.query(`UPDATE "HistoryArchiveControl" SET site_ids=ARRAY['site']; UPDATE "Site" SET user_id=null WHERE id='site'`);
        try {expect((await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions)).days).toEqual([]);}
        finally {await pool.query(`UPDATE "Site" SET user_id='owner' WHERE id='site'`);}
    });
    it('date cohorts bound discovery to whole site-local days',async()=>{
        await pool.query(`UPDATE "HistoryArchiveControl" SET paused=false,trim=true,from_date='2026-01-02',before_date='2026-01-03'`);
        expect((await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions)).days).toEqual([]);
        await pool.query(`UPDATE "HistoryArchiveControl" SET from_date='2026-01-01',before_date='2026-01-02'`);
        expect((await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions)).days[0].start).toBe(start.toISOString());
    });
    it('a timed-out archive transaction rolls back without losing raw history',async()=>{
        await pool.query(`CREATE FUNCTION slow_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(.1); RETURN NEW; END $$;
            CREATE TRIGGER slow_archive BEFORE INSERT ON "EnergyDayArchive" FOR EACH ROW EXECUTE FUNCTION slow_archive();`);
        try {
            await expect(new CompactHistoryStore(pool,10).finalizeDay('site',start,now)).rejects.toThrow();
            expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
            expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDayArchive"')).rows[0].n).toBe(0);
        } finally {await pool.query('DROP TRIGGER slow_archive ON "EnergyDayArchive"; DROP FUNCTION slow_archive()');}
    });
    it('daily job response transfer fits its conservative reservation',async()=>{
        const {PostgresTransferMeter}=await import('./postgres-transfer-meter');
        const meter=new PostgresTransferMeter(socket!);await meter.start();
        const metered=new Pool({host:meter.host,port:55439,database,user:process.env.USER,max:3});
        try {
            await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true');
            await pool.query('TRUNCATE "EnergyData"');
            await pool.query(`INSERT INTO "EnergyData" SELECT 'site',$1::timestamptz+n*interval '5 minutes',1,2,20,3,10,-2,null FROM generate_series(0,287) n`,[start]);
            await metered.query('SELECT 1');
            const measured=await meter.measure(()=>runHistoryArchive(new HistoryArchiveRepo(metered),jobOptions));
            expect(measured.value.days[0]).toMatchObject({status:'trimmed',samples:288});
            expect(measured.transfer.bytes).toBeLessThan(measured.value.estimatedBytes);
            const repeat=await meter.measure(()=>runHistoryArchive(new HistoryArchiveRepo(metered),jobOptions));
            expect(repeat.value.days).toEqual([]);expect(repeat.transfer.bytes).toBeLessThan(32768);
        } finally {await metered.end();await meter.close();}
    });
    it('admits only whole days outside retention including DST and exact cutoff',async()=>{
        const repo=new HistoryArchiveRepo(pool);await repo.claim();
        try {
            expect(await repo.next(true,9,jobOptions.now)).toBeNull();
            expect((await repo.next(true,8,jobOptions.now))?.start).toEqual(start);
            const cutoff=archiveCutoff(new Date('2026-03-10T12:00:00Z'),'America/Chicago',2);
            expect(cutoff.toISOString()).toBe('2026-03-08T06:00:00.000Z');
        } finally {await repo.release();}
    });
    it('a second runner cannot claim the active job and pause is persistent',async()=>{
        const held=new HistoryArchiveRepo(pool);await held.claim();
        try {expect((await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions)).stopped).toBe('busy');}
        finally {await held.release();}
        expect((await runHistoryArchive(new HistoryArchiveRepo(pool),jobOptions)).stopped).toBe('paused');
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
    });
    it('runs the claimed job without JIT and leaves pooled sessions unchanged',async()=>{
        const before=(await pool.query('SHOW jit')).rows[0].jit;
        const held=new HistoryArchiveRepo(pool);await held.claim();
        try {expect((await (held as unknown as {client:{query:(sql:string)=>Promise<{rows:{jit:string}[]}>}}).client.query('SHOW jit')).rows[0].jit).toBe('off');}
        finally {await held.release();}
        expect((await pool.query('SHOW jit')).rows[0].jit).toBe(before);
    });
    it('preflight refuses transfer over budget without changing raw samples',async()=>{
        await pool.query('UPDATE "HistoryArchiveControl" SET paused=false,trim=true');
        const report=await runHistoryArchive(new HistoryArchiveRepo(pool),{...jobOptions,maxEstimatedBytes:40000});
        expect(report.stopped).toBe('byte-budget');expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDayArchive"')).rows[0].n).toBe(0);
    });
    it('trims a reviewed day while preserving its archive, summaries and reader parity',async()=>{
        const finalized=await store.finalizeDay('site',start,now);
        const original=(await store.readVerificationSnapshot('site',start,end)).raw;
        const trimNow=new Date('2026-01-05T12:00:00Z');
        expect(await store.trimDay('site',start,finalized.revision!,trimNow)).toEqual({status:'trimmed',samples:2});
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(0);
        const state=(await pool.query('SELECT revision,raw_pruned FROM "EnergyDayArchive"')).rows[0];
        expect(state).toEqual({revision:finalized.revision,raw_pruned:true});
        const reader=new CompactHistoryReader(store,'America/Chicago');
        expect(await reader.getRawEnergyData('site',start,end)).toEqual(original);
        expect((await reader.getCycleAggregates('site',start,end))[0].grid_power).toBe(5);
        expect(await store.trimDay('site',start,finalized.revision!,trimNow)).toEqual({status:'already-trimmed',samples:0});
        expect((await store.finalizeDay('site',start,now)).status).toBe('unchanged');
        const preview=await store.getMaintenanceSnapshot('site','2026-01-01','2026-01-02',false,trimNow);
        expect(preview.coverage[0].count).toBe(2);
        const {runCompactMaintenance}=await import('./compact-history-maintenance');
        const report=await runCompactMaintenance(store,{siteId:'site',from:'2026-01-01',before:'2026-01-02',now:trimNow});
        expect(report.rawDeletionPerformed).toBe(false);expect(report.rawDataRetained).toBe(false);expect(report.days[0].rawPruned).toBe(true);
        await expect(store.getMaintenanceSnapshot('site','2026-01-01','2026-01-02',true,trimNow)).rejects.toThrow('Restore pruned days before rebuilding');
    });
    it('requires a current revision, mature day, complete attribution and intact chart/summaries for trim',async()=>{
        const first=await store.finalizeDay('site',start,now);
        await expect(store.trimDay('site',start,'00000000-0000-0000-0000-000000000000',new Date('2026-01-05'))).rejects.toThrow('revision');
        await expect(store.trimDay('site',start,first.revision!,now)).rejects.toThrow('recent');
        await pool.query('UPDATE "EnergyDaySummary" SET grid_power=999');
        await expect(store.trimDay('site',start,first.revision!,new Date('2026-01-05'))).rejects.toThrow();
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
        const next=await store.finalizeDay('site',start,now);
        await pool.query(`UPDATE "EnergyDayArchive" SET payload=decode('00','hex')`);
        await expect(store.trimDay('site',start,next.revision!,new Date('2026-01-05'))).rejects.toThrow();
        await pool.query('UPDATE "EnergyData" SET tariff_schedule_id=NULL');
        const incomplete=await store.finalizeDay('site',start,now);
        await expect(store.trimDay('site',start,incomplete.revision!,new Date('2026-01-05'))).rejects.toThrow('Incomplete tariff attribution');
    });
    it('restores an archived day exactly and blocks uncoordinated mutations and timezone changes first',async()=>{
        const first=await store.finalizeDay('site',start,now);
        const original=(await store.readVerificationSnapshot('site',start,end)).raw;
        await store.trimDay('site',start,first.revision!,new Date('2026-01-05'));
        await expect(pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,1,1,1,1,null)`,[new Date(+start+600000)])).rejects.toThrow('Restore pruned');
        await expect(pool.query(`UPDATE "Site" SET timezone='America/New_York' WHERE id='site'`)).rejects.toThrow('Restore pruned');
        expect(await store.restoreDay('site',start,first.revision!)).toEqual({status:'restored',samples:2});
        expect((await store.readVerificationSnapshot('site',start,end)).raw).toEqual(original);
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDayArchive"')).rows[0].n).toBe(0);
        await pool.query(`UPDATE "Site" SET timezone='America/New_York' WHERE id='site'`);
    });
    it('restores untouched samples before a partial late import and preserves existing SOC',async()=>{
        const first=await store.finalizeDay('site',start,now);
        await store.trimDay('site',start,first.revision!,new Date('2026-01-05'));
        await store.writeEnergyDataBatch([{site_id:'site',timestamp:new Date(+start+300000),tariff_id:1,tariff_schedule_id:2,load_power:25,solar_power:3,grid_power:99,battery_power:-2,battery_soc:null}]);
        const raw=(await store.readVerificationSnapshot('site',start,end)).raw;
        expect(raw).toHaveLength(2);expect(raw[0].grid_power).toBe(10);expect(raw[1].grid_power).toBe(99);expect(raw[1].battery_soc).toBe(50);
        await store.finalizeDay('site',start,now);
        expect((await new CompactHistoryReader(store,'America/Chicago').getCycleAggregates('site',start,end))[0].grid_power).toBe(109);
    });
    it('rolls back restoration when the incoming batch fails',async()=>{
        const first=await store.finalizeDay('site',start,now);
        await store.trimDay('site',start,first.revision!,new Date('2026-01-05'));
        await pool.query(`CREATE FUNCTION fail_energy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.grid_power=999 THEN RAISE EXCEPTION 'fixture incoming failure'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER fail_energy BEFORE INSERT ON "EnergyData" FOR EACH ROW EXECUTE FUNCTION fail_energy();`);
        try {
            await expect(store.writeEnergyDataBatch([{site_id:'site',timestamp:start,tariff_id:1,tariff_schedule_id:2,load_power:20,solar_power:3,grid_power:999,battery_power:-2,battery_soc:null}])).rejects.toThrow('fixture incoming failure');
            expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(0);
            expect((await pool.query('SELECT revision,raw_pruned FROM "EnergyDayArchive"')).rows[0]).toEqual({revision:first.revision,raw_pruned:true});
        } finally {await pool.query('DROP TRIGGER fail_energy ON "EnergyData";DROP FUNCTION fail_energy()');}
    });
    it('does not discard a corrupt authoritative archive during restoration or finalization',async()=>{
        const first=await store.finalizeDay('site',start,now);
        await store.trimDay('site',start,first.revision!,new Date('2026-01-05'));
        await pool.query('UPDATE "EnergyDaySummary" SET grid_power=999');
        await expect(store.restoreDay('site',start,first.revision!)).rejects.toThrow();
        await expect(store.finalizeDay('site',start,now)).rejects.toThrow();
        expect((await pool.query('SELECT raw_pruned FROM "EnergyDayArchive"')).rows[0].raw_pruned).toBe(true);
    });
    it('protects archive-only data even if its pruning marker is damaged',async()=>{
        const first=await store.finalizeDay('site',start,now);
        await store.trimDay('site',start,first.revision!,new Date('2026-01-05'));
        await pool.query('UPDATE "EnergyDayArchive" SET raw_pruned=false');
        await expect(pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,1,1,1,1,null)`,[start])).rejects.toThrow('Raw archive source incomplete');
        await expect(pool.query(`UPDATE "Site" SET timezone='America/New_York' WHERE id='site'`)).rejects.toThrow('Restore pruned');
        expect((await pool.query('SELECT revision FROM "EnergyDayArchive"')).rows[0].revision).toBe(first.revision);
    });
    it('restores irregular multi-chunk samples and exact double values including signed zero',async()=>{
        await pool.query('TRUNCATE "EnergyData"');
        await pool.query(`INSERT INTO "EnergyData" SELECT 'site',$1::timestamptz+n*interval '30 seconds',1,2,.1234567891234567,3,'-0'::float8,-2,NULL FROM generate_series(0,599) n`,[start]);
        const first=await store.finalizeDay('site',start,now);
        const original=(await store.readVerificationSnapshot('site',start,end)).raw;
        expect(Object.is(original[0].grid_power,-0)).toBe(true);
        await store.trimDay('site',start,first.revision!,new Date('2026-01-05'));
        expect((await store.restoreDay('site',start,first.revision!)).samples).toBe(600);
        expect((await store.readVerificationSnapshot('site',start,end)).raw).toEqual(original);
    });
    it('rolls back raw pruning when deletion fails after the authoritative marker is set',async()=>{
        const first=await store.finalizeDay('site',start,now);
        await pool.query(`CREATE FUNCTION fail_prune() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture trim failure'; END $$;
            CREATE TRIGGER fail_prune BEFORE DELETE ON "EnergyData" FOR EACH ROW EXECUTE FUNCTION fail_prune();`);
        try {
            await expect(store.trimDay('site',start,first.revision!,new Date('2026-01-05'))).rejects.toThrow('fixture trim failure');
            expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
            expect((await pool.query('SELECT raw_pruned FROM "EnergyDayArchive"')).rows[0].raw_pruned).toBe(false);
        } finally {await pool.query('DROP TRIGGER fail_prune ON "EnergyData";DROP FUNCTION fail_prune()');}
    });
    it('skips trim and restoration while another mutation or cleanup claim is held',async()=>{
        const first=await store.finalizeDay('site',start,now);
        const blocker=await pool.connect();
        try {
            await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('compact-energy:site',0))");
            expect(await store.trimDay('site',start,first.revision!,new Date('2026-01-05'))).toEqual({status:'busy',samples:0});
            expect(await store.restoreDay('site',start,first.revision!)).toEqual({status:'busy',samples:0});
            await blocker.query('ROLLBACK');await blocker.query('BEGIN');
            await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('compact-energy-maintenance',0))");
            await expect(store.writeEnergyDataBatch([{site_id:'site',timestamp:start,tariff_id:1,load_power:1,solar_power:1,grid_power:1,battery_power:1,battery_soc:null}])).rejects.toThrow('claim busy');
        } finally {await blocker.query('ROLLBACK');blocker.release();}
    });
    it('never replaces a complete archive from a damaged marker and partial raw source',async()=>{
        const first=await store.finalizeDay('site',start,now);
        await pool.query('ALTER TABLE "EnergyData" DISABLE TRIGGER USER');
        try {await pool.query('DELETE FROM "EnergyData" WHERE timestamp=$1',[start]);}
        finally {await pool.query('ALTER TABLE "EnergyData" ENABLE TRIGGER USER');}
        await expect(store.finalizeDay('site',start,now)).rejects.toThrow('Raw archive source incomplete');
        expect((await pool.query('SELECT revision,sample_count FROM "EnergyDayArchive"')).rows[0]).toEqual({revision:first.revision,sample_count:2});
        expect(await new CompactHistoryReader(store,'America/Chicago').getRawEnergyData('site',start,end)).toHaveLength(2);
    });
    it('rejects an oversized restoration cohort before fetching or restoring its charts',async()=>{
        const incoming=[];
        for(let i=0;i<8;i++) {
            const day=new Date(+start+i*86400000);
            if(i)await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,1,1,1,1,null)`,[day]);
            const built=await store.finalizeDay('site',day,new Date('2026-01-20'));
            await store.trimDay('site',day,built.revision!,new Date('2026-01-20'));
            incoming.push({site_id:'site',timestamp:day,tariff_id:1,load_power:1,solar_power:1,grid_power:1,battery_power:1,battery_soc:null});
        }
        await expect(store.writeEnergyDataBatch(incoming)).rejects.toThrow('restoration exceeds seven days');
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDayArchive" WHERE raw_pruned')).rows[0].n).toBe(8);
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(0);
    });
    it('bounds trim/restoration transfer and keeps ordinary compact writes scalar',async()=>{
        await pool.query(`INSERT INTO "EnergyData" SELECT 'site',$1::timestamptz+n*interval '5 minutes',1,2,random()*100,random()*100,random()*100,random()*100,random()*100 FROM generate_series(2,287) n`,[start]);
        const built=await store.finalizeDay('site',start,now);
        const original=(await store.readVerificationSnapshot('site',start,end)).raw;
        const {PostgresTransferMeter}=await import('./postgres-transfer-meter');
        const meter=new PostgresTransferMeter(socket!);await meter.start();
        const meteredPool=new Pool({host:meter.host,port:55439,database,user:process.env.USER,max:1});
        try {
            await meteredPool.query('SELECT 1');const meteredStore=new CompactHistoryStore(meteredPool,undefined,async client=>{await client.query('SELECT 1');});
            const trimmed=await meter.measure(()=>meteredStore.trimDay('site',start,built.revision!,new Date('2026-01-05')));
            expect(trimmed.value.status).toBe('trimmed');expect(trimmed.transfer.bytes).toBeLessThan(35000);
            const restored=await meter.measure(()=>meteredStore.restoreDay('site',start,built.revision!));
            expect(restored.value.samples).toBe(288);expect(restored.transfer.bytes).toBeLessThan(35000);
            expect((await store.readVerificationSnapshot('site',start,end)).raw).toEqual(original);
            const written=await meter.measure(()=>meteredStore.writeEnergyDataBatch([original[0]]));
            expect(written.transfer.bytes).toBeLessThan(2000);expect(written.transfer.selectRequests).toBe(3);
        } finally {await meteredPool.end();await meter.close();}
    });
    it('previews raw coverage and verifies archived days using scalar maintenance metadata',async()=>{
        const preview=await store.getMaintenanceSnapshot('site','2026-01-01','2026-01-02',false,new Date('2026-01-05'));
        expect(preview.coverage).toMatchObject([{localDayKey:'2026-01-01',count:2}]);expect(preview.archives).toEqual([]);
        await store.finalizeDay('site',start,now);
        expect((await store.getMaintenanceSnapshot('site','2026-01-01','2026-01-02',false,new Date('2026-01-05'))).archives).toEqual([{start,attributionComplete:true}]);
        await pool.query(`UPDATE "EnergyDayArchive" SET payload=decode('00','hex')`);
        await expect(store.getMaintenanceSnapshot('site','2026-01-01','2026-01-02',false,new Date('2026-01-05'))).rejects.toThrow('Archive integrity mismatch');
        expect((await store.getMaintenanceSnapshot('site','2026-01-01','2026-01-02',true,new Date('2026-01-05'))).coverage[0].count).toBe(2);
    });
    it('rejects oversized, recent, invalid or unknown-site maintenance before touching history',async()=>{
        for(const [from,before] of [['2026-01-01','2026-03-01'],['2026-01-03','2026-01-04'],['2026-02-30','2026-03-01']]) {
            await expect(store.getMaintenanceSnapshot('site',from,before,false,new Date('2026-01-05'))).rejects.toThrow();
        }
        await expect(store.getMaintenanceSnapshot('missing','2026-01-01','2026-01-02',false,now)).rejects.toThrow('Site not found');
    });
    it('uses site-local DST bounds and refuses invalid timezone fallback for maintenance',async()=>{
        const preview=await store.getMaintenanceSnapshot('site','2026-03-08','2026-03-09',false,new Date('2026-03-12'));
        expect(+preview.end-+preview.start).toBe(23*3600000);
        await pool.query("UPDATE \"Site\" SET timezone='invalid' WHERE id='site'");
        await expect(store.getMaintenanceSnapshot('site','2026-01-01','2026-01-02',false,new Date('2026-01-05'))).rejects.toThrow();
    });
    it('serializes legacy cleanup with first archive finalization and preserves both sources once archived', async () => {
        const blocker = await pool.connect();
        try {
            await blocker.query('BEGIN');
            await blocker.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('compact-energy-maintenance',0))");
            expect(await store.cleanupLegacyHistory(end)).toEqual({skipped:true});
            expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
            await blocker.query('ROLLBACK');
            await blocker.query('BEGIN');
            await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('compact-energy-maintenance',0))");
            expect(await store.finalizeDay('site',start,now)).toEqual({status:'busy'});
            await blocker.query('ROLLBACK');
            await store.finalizeDay('site',start,now);
            await pool.query('INSERT INTO "LoadTag" VALUES ($1)',[start]);
            expect(await store.cleanupLegacyHistory(end)).toEqual({skipped:true});
            expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
            expect((await pool.query('SELECT count(*)::int AS n FROM "LoadTag"')).rows[0].n).toBe(1);
        } finally {await blocker.query('ROLLBACK');blocker.release();}
    });
    it('retains legacy cutoff behavior atomically when no archives exist', async () => {
        await pool.query('INSERT INTO "LoadTag" VALUES ($1),($2)',[start,end]);
        expect(await store.cleanupLegacyHistory(end)).toEqual({skipped:false,energyDeleted:2,tagsDeleted:1});
        expect((await pool.query('SELECT count(*)::int AS n FROM "LoadTag"')).rows[0].n).toBe(1);
    });
    it('atomically persists a verified revision without deleting raw rows and retries unchanged', async () => {
        const first = await store.finalizeDay('site', start, now);
        expect(first.status).toBe('finalized');
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyData"')).rows[0].n).toBe(2);
        expect(await store.finalizeDay('site', start, now)).toEqual({ ...first, status: 'unchanged' });
        const snapshot = await store.readSnapshot('site', start, end);
        expect(snapshot.days[0].attributionComplete).toBe(true);
        expect(snapshot.days[0].summaries[0].grid_power).toBe(5);
        const reader = new CompactHistoryReader(store,'America/Chicago');
        expect(await reader.getRawEnergyData('site', start, end)).toHaveLength(2);
        expect((await reader.getCycleAggregates('site', start, end))[0].grid_power).toBe(5);
        expect((await reader.getCycleAggregates('site', new Date(+start+300000), end))[0].grid_power).toBe(-5);
    });
    it('keeps full double precision when sessions default to extra_float_digits=0 (Supabase pooler)', async () => {
        // Supabase's postgresql.conf sets extra_float_digits=0, so text-format float8 reads
        // round to 15 significant digits unless each transaction raises it.
        const rounding = new Pool({ host: socket, port: 55439, database, user: process.env.USER, max: 2, options: '-c extra_float_digits=0' });
        try {
            expect((await rounding.query('SELECT 7631.409423828125::float8 AS v')).rows[0].v).toBe(7631.40942382812);
            await pool.query('UPDATE "EnergyData" SET solar_power=$1, load_power=$2 WHERE timestamp=$3', [7631.409423828125, 0.1 + 0.2, start]);
            const rounded = new CompactHistoryStore(rounding, 15000, async client => { await client.query('SELECT 1'); });
            expect((await rounded.finalizeDay('site', start, now)).status).toBe('finalized');
            const reader = new CompactHistoryReader(rounded, 'America/Chicago');
            const rows = await reader.getRawEnergyData('site', start, end);
            expect(rows[0].solar_power).toBe(7631.409423828125);
            expect(rows[0].load_power).toBe(0.1 + 0.2);
            const snapshot = await rounded.readVerificationSnapshot('site', start, end);
            expect(snapshot.days[0].summaries[0].solar_power).toBe(7631.409423828125 + 3);
            expect((await rounded.finalizeDay('site', start, now)).status).toBe('unchanged');
        } finally { await rounding.end(); }
    });
    it('invalidates archives on correction, then rebuilds a new revision', async () => {
        const first = await store.finalizeDay('site', start, now);
        await pool.query('UPDATE "EnergyData" SET grid_power=100 WHERE timestamp=$1', [start]);
        expect((await store.readSnapshot('site', start, end)).days).toEqual([]);
        const rebuilt = await store.finalizeDay('site', start, now);
        expect(rebuilt.revision).not.toBe(first.revision);
        expect((await store.readSnapshot('site', start, end)).days[0].summaries[0].grid_power).toBe(95);
    });
    it('invalidates on late insert, delete and moved timestamps', async () => {
        await store.finalizeDay('site', start, now);
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,1,1,1,1,null)`, [new Date(+start+600000)]);
        expect((await store.readSnapshot('site',start,end)).days).toHaveLength(0);
        await store.finalizeDay('site', start, now);
        await pool.query('UPDATE "EnergyData" SET timestamp=$1 WHERE timestamp=$2', [end,start]);
        expect((await store.readSnapshot('site',start,end)).days).toHaveLength(0);
        await store.finalizeDay('site', start, now);
        await pool.query('DELETE FROM "EnergyData" WHERE timestamp=$1', [new Date(+start+300000)]);
        expect((await store.readSnapshot('site',start,end)).days).toHaveLength(0);
    });
    it('rolls back a failed summary write with no partial archive', async () => {
        await pool.query(`CREATE FUNCTION fail_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
            CREATE TRIGGER fail_summary BEFORE INSERT ON "EnergyDaySummary" FOR EACH ROW EXECUTE FUNCTION fail_summary();`);
        try {
            await expect(store.finalizeDay('site',start,now)).rejects.toThrow('fixture failure');
            expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDayArchive"')).rows[0].n).toBe(0);
        } finally { await pool.query('DROP TRIGGER fail_summary ON "EnergyDaySummary"; DROP FUNCTION fail_summary()'); }
    });
    it('skips a busy claim and sees an import committed before acquiring its lock', async () => {
        const writer = await pool.connect();
        try {
            await writer.query('BEGIN');
            await writer.query('UPDATE "EnergyData" SET grid_power=200 WHERE timestamp=$1',[start]);
            expect((await store.finalizeDay('site',start,now)).status).toBe('busy');
            await writer.query('COMMIT');
            await store.finalizeDay('site',start,now);
            expect((await store.readSnapshot('site',start,end)).days[0].summaries[0].grid_power).toBe(195);
        } finally { await writer.query('ROLLBACK'); writer.release(); }
    });
    it('serializes concurrent finalizers', async () => {
        const outcomes = await Promise.all([store.finalizeDay('site',start,now),store.finalizeDay('site',start,now)]);
        expect(outcomes.some(r => r.status==='finalized')).toBe(true);
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDayArchive"')).rows[0].n).toBe(1);
    });
    it('keeps unresolved historical schedules incomplete without mutating raw IDs', async () => {
        await pool.query('UPDATE "EnergyData" SET tariff_schedule_id=null');
        await store.finalizeDay('site', start, now);
        expect((await store.readSnapshot('site',start,end)).days[0].attributionComplete).toBe(false);
        expect((await pool.query('SELECT tariff_schedule_id FROM "EnergyData"')).rows.every(r=>r.tariff_schedule_id===null)).toBe(true);
    });
    it('rejects open/invalid days and excessively large detail windows', async () => {
        await expect(store.finalizeDay('site',now,now)).rejects.toThrow('completed local day');
        await expect(store.finalizeDay('site',new Date(+start+300000),now)).rejects.toThrow('completed local day');
        await expect(store.readSnapshot('site',start,new Date(+start+400*86400000))).rejects.toThrow('History window');
    });
    it('invalidates archives when the site timezone is corrected', async () => {
        await store.finalizeDay('site',start,now);
        await pool.query(`UPDATE "Site" SET timezone='America/New_York' WHERE id='site'`);
        expect((await store.readSnapshot('site',start,end)).days).toHaveLength(0);
        const changedStart = new Date('2026-01-01T05:00:00Z');
        expect((await store.finalizeDay('site',changedStart,now)).status).toBe('finalized');
        await pool.query(`UPDATE "Site" SET timezone='America/Chicago' WHERE id='site'`);
    });
    it('repairs corrupted stored summaries on a finalization retry', async () => {
        const first = await store.finalizeDay('site',start,now);
        await pool.query('UPDATE "EnergyDaySummary" SET grid_power=999');
        const rebuilt = await store.finalizeDay('site',start,now);
        expect(rebuilt.status).toBe('finalized');
        expect(rebuilt.revision).not.toBe(first.revision);
        expect((await store.readSnapshot('site',start,end)).days[0].summaries[0].grid_power).toBe(5);
    });
    it('coordinates a concurrent timezone correction with finalization', async () => {
        const writer = await pool.connect();
        try {
            await writer.query('BEGIN');
            await writer.query(`UPDATE "Site" SET timezone='America/New_York' WHERE id='site'`);
            expect((await store.finalizeDay('site',start,now)).status).toBe('busy');
            await writer.query('COMMIT');
            const changedStart = new Date('2026-01-01T05:00:00Z');
            expect((await store.finalizeDay('site',changedStart,now)).status).toBe('finalized');
        } finally { await writer.query('ROLLBACK'); writer.release(); }
    });
    it('denies anonymous reads and permits service reads with RLS enabled', async () => {
        await store.finalizeDay('site',start,now);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE anon');
            await expect(client.query('SELECT * FROM "EnergyDayArchive"')).rejects.toThrow('permission denied');
            await client.query('ROLLBACK');
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE service_role');
            expect((await client.query('SELECT * FROM "EnergyDayArchive"')).rows).toHaveLength(1);
            await client.query('COMMIT');
        } finally { await client.query('ROLLBACK'); client.release(); }
    });
    it('bills complete days from checksummed summaries without loading the chart payload', async () => {
        await store.finalizeDay('site',start,now);
        // Simulate a chart-only corruption; billing's independent metadata digest remains valid.
        await pool.query(`UPDATE "EnergyDayArchive" SET payload=decode('00','hex')`);
        const reader=new CompactHistoryReader(store,'America/Chicago');
        expect((await reader.getCycleAggregates('site',start,end))[0].grid_power).toBe(5);
        expect(await reader.getDailyCoverage('site',start,end,'America/Chicago')).toEqual([{localDayKey:'2026-01-01',count:2,first:start,last:new Date(+start+300000),maxInteriorGapMs:300000,archived:false}]);
        await expect(reader.getRawEnergyData('site',start,end)).rejects.toThrow();
        await expect(reader.getCycleAggregates('site',new Date(+start+300000),end)).rejects.toThrow();
    });
    it('rejects corrupted summary totals on the fast billing path', async () => {
        await store.finalizeDay('site',start,now);
        await pool.query('UPDATE "EnergyDaySummary" SET grid_power=999');
        await expect(new CompactHistoryReader(store,'America/Chicago').getCycleAggregates('site',start,end)).rejects.toThrow('Day metadata mismatch');
    });
    it('falls back to decoding older revisions until metadata is rebuilt', async () => {
        await store.finalizeDay('site',start,now);
        await pool.query('UPDATE "EnergyDayArchive" SET metadata_checksum=null,first_timestamp=null,last_timestamp=null,max_interior_gap_ms=null');
        const reader=new CompactHistoryReader(store,'America/Chicago');
        expect((await reader.getCycleAggregates('site',start,end))[0].grid_power).toBe(5);
        expect((await store.finalizeDay('site',start,now)).status).toBe('finalized');
    });
    it('reports raw and archived existence and refuses stale site timezones', async () => {
        const reader=new CompactHistoryReader(store,'America/Chicago');
        expect(await reader.hasData('site')).toBe(true);
        expect(await reader.hasData('absent')).toBe(false);
        await store.finalizeDay('site',start,now);
        await pool.query(`UPDATE "Site" SET timezone='America/New_York' WHERE id='site'`);
        await expect(reader.getCycleAggregates('site',start,end)).rejects.toThrow('History timezone mismatch');
    });
    it('supports archive-only coverage/existence and mixed partial billing in a synthetic fixture', async () => {
        await store.finalizeDay('site',start,now);
        // Synthetic maintenance fixture models a future verified trim. No production
        // trim path exists; ordinary DELETE still invalidates the archive.
        await pool.query('TRUNCATE "EnergyData"');
        const reader=new CompactHistoryReader(store,'America/Chicago');
        expect(await reader.hasData('site')).toBe(true);
        expect(await reader.getRawEnergyData('site',start,end)).toHaveLength(2);
        expect((await reader.getDailyCoverage('site',start,end,'America/Chicago'))[0].count).toBe(2);
        expect((await reader.getCycleAggregates('site',new Date(+start+300000),end))[0].grid_power).toBe(-5);
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,1,1,100,1,null)`,[end]);
        const totals=await reader.getCycleAggregates('site',start,new Date(+end+300000));
        expect(totals.map(t=>t.grid_power)).toEqual([5,100]);
        expect((await reader.getDailyCoverage('site',start,new Date(+end+300000),'America/Chicago')).map(c=>c.count)).toEqual([2,1]);
    });
    it.each(['2026-03-08T06:00:00Z','2026-11-01T05:00:00Z'])('uses modern metadata across DST on %s',async iso=>{
        const {addDaysInSiteTimezone}=await import('../date-utils');
        const from=new Date(iso);const to=addDaysInSiteTimezone(from,1,'America/Chicago');
        await pool.query('TRUNCATE "EnergyData"');
        await pool.query(`INSERT INTO "EnergyData" SELECT 'site',ts,1,2,20,3,10,-2,null
            FROM generate_series($1::timestamptz,$2::timestamptz-interval '5 minutes',interval '5 minutes') ts`,[from,to]);
        await store.finalizeDay('site',from,new Date(+to+86400000));
        const reader=new CompactHistoryReader(store,'America/Chicago');
        const expected=(+to-+from)/300000;
        expect((await store.readAggregateSnapshot('site',from,to)).detail).toEqual({raw:[],days:[]});
        expect((await reader.getCycleAggregates('site',from,to))[0].grid_power).toBe(expected*10);
        expect((await reader.getDailyCoverage('site',from,to,'America/Chicago'))[0]).toMatchObject({count:expected,maxInteriorGapMs:300000});
    });
    it('uses corrected raw data for modern billing and coverage until rebuilt',async()=>{
        await store.finalizeDay('site',start,now);
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,20,3,100,-2,null)`,[new Date(+start+600000)]);
        const reader=new CompactHistoryReader(store,'America/Chicago');
        expect((await reader.getCycleAggregates('site',start,end))[0].grid_power).toBe(105);
        expect((await reader.getDailyCoverage('site',start,end,'America/Chicago'))[0].count).toBe(3);
        expect((await store.readAggregateSnapshot('site',start,end)).fullDays).toHaveLength(0);
        await store.finalizeDay('site',start,now);
        expect((await store.readAggregateSnapshot('site',start,end)).detail).toEqual({raw:[],days:[]});
        expect((await reader.getCycleAggregates('site',start,end))[0].grid_power).toBe(105);
    });
    it('transfers archived detail once and retains an explicit verification mode',async()=>{
        await store.finalizeDay('site',start,now);
        const normal=await store.readSnapshot('site',start,end);
        expect(normal.raw).toEqual([]);
        expect(normal.days).toHaveLength(1);
        const verify=await store.readVerificationSnapshot('site',start,end);
        expect(verify.raw).toHaveLength(2);
        expect(verify.days).toHaveLength(1);
    });
    it('excludes raw overlap for partial boundary and legacy archive reads',async()=>{
        await store.finalizeDay('site',start,now);
        const partial=await store.readAggregateSnapshot('site',new Date(+start+300000),end);
        expect(partial.detail.raw).toEqual([]);
        expect(partial.detail.days).toHaveLength(1);
        await pool.query('UPDATE "EnergyDayArchive" SET metadata_checksum=null,first_timestamp=null,last_timestamp=null,max_interior_gap_ms=null');
        const legacy=await store.readAggregateSnapshot('site',start,end);
        expect(legacy.detail.raw).toEqual([]);
        expect(legacy.detail.days).toHaveLength(1);
    });
    it('counts actual PostgreSQL response bytes through a private local meter',async()=>{
        const {PostgresTransferMeter}=await import('./postgres-transfer-meter');
        const meter=new PostgresTransferMeter(socket!);await meter.start();
        const meteredPool=new Pool({host:meter.host,port:55439,database,user:process.env.USER,max:1});
        try {
            await meteredPool.query('SELECT 1');
            const result=await meter.measure(()=>meteredPool.query<{payload:string}>("SELECT repeat('x',1000) AS payload"));
            expect(result.value.rows[0].payload).toHaveLength(1000);
            expect(result.transfer).toMatchObject({rows:1,requests:1,selectRequests:1});
            expect(result.transfer.bytes).toBeGreaterThan(1000);expect(result.transfer.bytes).toBeLessThan(1400);
        } finally {await meteredPool.end();await meter.close();}
    });
    it('verifies the canonical metadata digest in PostgreSQL before returning scalar projections',async()=>{
        await store.finalizeDay('site',start,now);
        expect((await pool.query<{ok:boolean}>('SELECT public.verify_compact_day_metadata($1,$2,false) AS ok',['site',start])).rows[0].ok).toBe(true);
        const projected=await store.readScalarSnapshot('site',start,end,{billing:true,coverage:true});
        expect(projected.aggregates[0].grid_power).toBe(5);expect(projected.coverage[0].count).toBe(2);
        expect(projected.detail).toEqual({raw:[],days:[]});
        await pool.query('UPDATE "EnergyDaySummary" SET grid_power=999');
        await expect(store.readScalarSnapshot('site',start,end,{billing:true,coverage:true})).rejects.toThrow('Day metadata mismatch');
    });
    it('rejects billing when every summary for an archived day is missing',async()=>{
        await store.finalizeDay('site',start,now);
        await pool.query('DELETE FROM "EnergyDaySummary"');
        await expect(store.readScalarSnapshot('site',start,end,{billing:true,coverage:false})).rejects.toThrow('Day metadata mismatch');
    });
    it('reads archived-only freshness without a modern chart payload',async()=>{
        await pool.query(`INSERT INTO "EnergyData" SELECT 'site',$1::timestamptz+n*interval '5 minutes',1,2,random()*100,random()*100,random()*100,random()*100,random()*100 FROM generate_series(2,287) n`,[start]);
        await store.finalizeDay('site',start,now);
        expect((await pool.query<{bytes:number}>('SELECT octet_length(payload) AS bytes FROM "EnergyDayArchive"')).rows[0].bytes).toBeGreaterThan(5000);
        // Model a post-trim fixture only; production deletion protocol is not enabled.
        await pool.query('ALTER TABLE "EnergyData" DISABLE TRIGGER USER');
        try {await pool.query('DELETE FROM "EnergyData"');}
        finally {await pool.query('ALTER TABLE "EnergyData" ENABLE TRIGGER USER');}
        const {PostgresTransferMeter}=await import('./postgres-transfer-meter');
        const meter=new PostgresTransferMeter(socket!);await meter.start();
        const meteredPool=new Pool({host:meter.host,port:55439,database,user:process.env.USER,max:1});
        try {
            await meteredPool.query('SELECT 1');
            const result=await meter.measure(()=>new CompactHistoryStore(meteredPool).getLatestTimestamp('site'));
            expect(result.value).toEqual(new Date(+end-300000));
            expect(result.transfer.bytes).toBeLessThan(1500);
            expect(result.transfer.selectRequests).toBe(2);
            const energy=await meter.measure(()=>new CompactHistoryStore(meteredPool).getLatestEnergyData('site'));
            const charge=await meter.measure(()=>new CompactHistoryStore(meteredPool).getLatestBatterySoc('site',start));
            expect(energy.value?.timestamp).toEqual(new Date(+end-300000));expect(charge.value?.timestamp).toEqual(new Date(+end-300000));
            expect(energy.transfer.bytes).toBeLessThan(3000);expect(charge.transfer.bytes).toBeLessThan(3000);
            expect(energy.transfer.selectRequests).toBe(2);expect(charge.transfer.selectRequests).toBe(3);
            const maintenance=await meter.measure(()=>new CompactHistoryStore(meteredPool).getMaintenanceSnapshot('site','2026-01-01','2026-01-02',false,new Date('2026-01-05')));
            expect(maintenance.value.archives).toHaveLength(1);expect(maintenance.transfer.bytes).toBeLessThan(2500);
            expect(maintenance.transfer.selectRequests).toBe(3);
        } finally {await meteredPool.end();await meter.close();}
    });
    it('compares raw and archived freshness and excludes future samples',async()=>{
        await store.finalizeDay('site',start,now);
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site',$1,1,2,0,0,0,0,null),('site',$2,1,2,0,0,0,0,null)`,[end,new Date('2099-01-01T00:00:00Z')]);
        expect(await store.getLatestTimestamp('site')).toEqual(end);
        expect(await store.getLatestTimestamp('other')).toBeNull();
    });
    it('fails freshness on corrupt modern metadata and decodes a legacy day',async()=>{
        await store.finalizeDay('site',start,now);
        await pool.query('UPDATE "EnergyDaySummary" SET grid_power=999');
        await expect(store.getLatestTimestamp('site')).rejects.toThrow('Day metadata mismatch');
        await store.finalizeDay('site',start,now);
        await pool.query('UPDATE "EnergyDayArchive" SET metadata_version=1');
        expect(await store.getLatestTimestamp('site')).toEqual(new Date(+start+300000));
    });
    it('reads multi-year scalar windows through the real store without losing archived days',async()=>{
        await store.finalizeDay('site',start,now);
        const result=await new CompactHistoryReader(store,'America/Chicago').getCycleAggregatesAndCoverage('site',new Date('2023-01-01T06:00:00Z'),end,'America/Chicago');
        expect(result.coverage).toHaveLength(1);expect(result.coverage[0].count).toBe(2);
        expect(result.aggregates).toHaveLength(1);expect(result.aggregates[0].grid_power).toBe(5);
    });
    it('preserves archived latest energy and distinct last known SOC timestamps',async()=>{
        await pool.query('UPDATE "EnergyData" SET battery_soc=CASE WHEN timestamp=$1 THEN 50 ELSE NULL END',[start]);
        await store.finalizeDay('site',start,now);
        await pool.query('ALTER TABLE "EnergyData" DISABLE TRIGGER USER');
        try {await pool.query('DELETE FROM "EnergyData"');}finally {await pool.query('ALTER TABLE "EnergyData" ENABLE TRIGGER USER');}
        expect(await store.getLatestEnergyData('site')).toEqual({timestamp:new Date(+start+300000),batterySoc:null,batteryPower:-2,solarPower:3,gridPower:-5,loadPower:20});
        expect(await store.getLatestBatterySoc('site',start)).toEqual({timestamp:start,value:50});
        expect(await store.getLatestBatterySoc('site',new Date(+start+1))).toBeNull();
        expect((await store.getLatestEnergyData('site',new Date(+start+1)))?.timestamp).toEqual(start);
    });
    it('rebuilds missing/corrupt projections and rejects tampered latest values',async()=>{
        await store.finalizeDay('site',start,now);
        await pool.query(`UPDATE "EnergyDayArchive" SET latest_metadata=jsonb_set(latest_metadata,'{sample,gridPower}','999'::jsonb)`);
        await expect(store.getLatestEnergyData('site')).rejects.toThrow('Latest metadata mismatch');
        expect((await store.finalizeDay('site',start,now)).status).toBe('finalized');
        await pool.query('UPDATE "EnergyDayArchive" SET latest_metadata=NULL,latest_checksum=NULL');
        expect((await store.getLatestEnergyData('site'))?.timestamp).toEqual(new Date(+start+300000));
        await expect(store.getLatestBatterySoc('site',start)).rejects.toThrow('Latest SOC metadata requires rebuild');
        expect((await store.finalizeDay('site',start,now)).status).toBe('finalized');
    });
    it('rejects a SOC timestamp tamper before it can hide from the indexed candidate lookup',async()=>{
        await store.finalizeDay('site',start,now);
        await pool.query(`UPDATE "EnergyDayArchive" SET latest_metadata=jsonb_set(latest_metadata,'{soc,timestamp}','0'::jsonb)`);
        await expect(store.getLatestBatterySoc('site',start)).rejects.toThrow('Latest metadata mismatch');
    });
    it('keeps future raw samples out of default energy and SOC freshness',async()=>{
        await store.finalizeDay('site',start,now);
        await pool.query(`INSERT INTO "EnergyData" VALUES ('site','2099-01-01',1,2,1,1,1,1,99)`);
        expect((await store.getLatestEnergyData('site'))?.timestamp).toEqual(new Date(+start+300000));
        expect(await store.getLatestBatterySoc('site',start)).toEqual({timestamp:new Date(+start+300000),value:50});
    });
    it('does not let an unverified first timestamp hide an as-of archive sample',async()=>{
        await store.finalizeDay('site',start,now);
        await pool.query('ALTER TABLE "EnergyData" DISABLE TRIGGER USER');
        try {await pool.query('DELETE FROM "EnergyData"');}finally {await pool.query('ALTER TABLE "EnergyData" ENABLE TRIGGER USER');}
        await pool.query('UPDATE "EnergyDayArchive" SET first_timestamp=last_timestamp');
        expect((await store.getLatestEnergyData('site',new Date(+start+1)))?.timestamp).toEqual(start);
    });
    it('exposes a cheap archive-existence guard for legacy cleanup',async()=>{
        expect(await store.hasAnyArchives()).toBe(false);
        await store.finalizeDay('site',start,now);expect(await store.hasAnyArchives()).toBe(true);
    });
    it('rejects fractional timestamps and unbounded raw digest requests',async()=>{
        await expect(pool.query('SELECT * FROM public.compact_raw_day_digest($1,$2,$3)',['site',start,new Date(+start+28*3600000)])).rejects.toThrow('Invalid raw digest bounds');
        await pool.query(`UPDATE "EnergyData" SET timestamp=timestamp+interval '1 microsecond' WHERE site_id='site' AND timestamp=$1`,[start]);
        await expect(pool.query('SELECT * FROM public.compact_raw_day_digest($1,$2,$3)',['site',start,end])).rejects.toThrow('Unsupported raw digest source');
    });
    it('restricts both tables and function execution to service access'    , async () => {
        for (const table of ['EnergyDayArchive','EnergyDaySummary']) {
            const result = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass`, [`"${table}"`]);
            expect(result.rows[0].relrowsecurity).toBe(true);
            const grants = await pool.query(`SELECT has_table_privilege('anon',$1,'SELECT') AS anon,
                has_table_privilege('authenticated',$1,'SELECT') AS authenticated,
                has_table_privilege('service_role',$1,'SELECT,INSERT,UPDATE,DELETE') AS service`, [`"${table}"`]);
            expect(grants.rows[0]).toEqual({ anon:false, authenticated:false, service:true });
        }
        for(const signature of ['public.compact_raw_day_digest(text,timestamptz,timestamptz)','public.verify_compact_latest_metadata(text,timestamptz)','public.verify_compact_day_metadata(text,timestamptz,boolean)']) {
            const grants=await pool.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,has_function_privilege('authenticated',$1,'EXECUTE') AS authenticated,has_function_privilege('service_role',$1,'EXECUTE') AS service`,[signature]);
            expect(grants.rows[0]).toEqual({anon:false,authenticated:false,service:true});
        }
    });
});
