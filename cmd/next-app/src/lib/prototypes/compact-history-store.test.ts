import {EnergyRepo} from '../energy-repo';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {addDaysInSiteTimezone} from '../date-utils';
import { readFileSync, statSync } from 'node:fs';
import { CompactHistoryStore } from './compact-history-store';
import { encodeDaySamples } from './compact-energy';
import { buildDayMetadataV3 } from './compact-day-metadata';
import type { DayAttribution } from './day-attribution';
import {latestStoredSampleSql} from '../latest-stored-sample-sql';
import { CompactHistoryReader } from './compact-history-reader';

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
            CREATE TABLE "Tariff" (id int PRIMARY KEY, site_id text, name text, updated timestamptz, is_current boolean NOT NULL DEFAULT true);
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
        await pool.query(readFileSync(new URL('../../../db-migrations/20261024180000_history_archive_all_sites.sql',import.meta.url),'utf8'));
        // Applied twice: migrations must be idempotent.
        for(let run=0;run<2;run++) await pool.query(readFileSync(new URL('../../../db-migrations/20261024190000_day_record_v2_schema.sql',import.meta.url),'utf8'));
        for(let run=0;run<2;run++) await pool.query(readFileSync(new URL('../../../db-migrations/20261025120000_day_record_empty_days.sql',import.meta.url),'utf8'));
        for(let run=0;run<2;run++) await pool.query(readFileSync(new URL('../../../db-migrations/20261025131043_day_record_empty_status.sql',import.meta.url),'utf8'));
        // The single compact store: raw EnergyData, its trigger and the archive job's tables go.
        for(let run=0;run<2;run++) await pool.query(readFileSync(new URL('../../../db-migrations/20261027120000_drop_energy_data.sql',import.meta.url),'utf8'));
        await pool.query("ALTER TABLE \"Site\" ADD COLUMN user_id text DEFAULT 'owner'");
        store = new CompactHistoryStore(pool,15000,async client=>{await client.query('SELECT 1');});
    });
    beforeEach(async () => {
        await pool.query('TRUNCATE "LoadTag", "EnergyDayArchive" CASCADE');
        await pool.query(`UPDATE "Site" SET timezone='America/Chicago' WHERE id='site'`);
    });
    afterAll(async () => {
        await pool?.end();
        if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS ${database}`); } finally { await admin.end(); } }
    });
    const jobOptions={now:new Date('2026-01-10T12:00:00Z')};
    const daySamples=(solar=3)=>Array.from({length:288},(_,n)=>({site_id:'site',timestamp:new Date(+start+n*300000),tariff_id:1,tariff_schedule_id:2,
        load_power:20,solar_power:solar,grid_power:10,battery_power:-2,battery_soc:n%12===0?50:null}));
    const fetched=new Date('2026-01-09T12:00:00Z');
    it('writes a whole day from samples as the only copy, readable and billable',async()=>{
        const samples=daySamples();
        const result=await store.writeDay('site',start,samples,fetched,jobOptions.now);
        expect(result).toMatchObject({status:'written',attributionComplete:true,dayStatus:'complete',revision:expect.any(String)});
        expect((await pool.query('SELECT raw_pruned,sample_count,format_version,metadata_version,status FROM "EnergyDayArchive"')).rows)
            .toEqual([{raw_pruned:true,sample_count:288,format_version:2,metadata_version:3,status:'complete'}]);
        const reader=new CompactHistoryReader(store,'America/Chicago');
        expect(await reader.getRawEnergyData('site',start,end)).toEqual(samples);
        expect((await reader.getDailyCoverage('site',start,end,'America/Chicago'))[0]).toMatchObject({count:288,archived:true});
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDaySummary"')).rows[0].n).toBeGreaterThan(0);
    });
    it('counts an open day written straight from Tesla by its stored samples for the gap-heal pre-check',async()=>{
        // 100 of 288 slots, ended 8 days ago: open, so not settled.
        expect(await store.writeDay('site',start,daySamples().slice(0,100),fetched,jobOptions.now)).toMatchObject({status:'written',dayStatus:'open'});
        const later=addDaysInSiteTimezone(end,1,'America/Chicago');
        expect((await EnergyRepo.countAlignedSamples([{siteId:'site',start,end:later}],pool)).get('site')).toBe(100);
        expect((await new CompactHistoryReader(store,'America/Chicago').getDailyCoverage('site',start,end,'America/Chicago'))[0])
            .toMatchObject({count:100,archived:false});
    });
    it('refuses samples off the 5-minute grid, which would make the slot count meaningless',async()=>{
        const samples=daySamples().map((r,n)=>({...r,timestamp:new Date(+r.timestamp+(n%2?1000:0))}));
        await expect(store.writeDay('site',start,samples,fetched,jobOptions.now)).rejects.toThrow(/grid/);
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDayArchive"')).rows[0].n).toBe(0);
    });
    it('finds the newest stored sample in day records, skipping empty ones',async()=>{
        const latest=async(site='site')=>(await pool.query<{at:Date|null}>(`SELECT ${latestStoredSampleSql('$1')} AS at`,[site])).rows[0].at;
        expect(await latest()).toBeNull();
        await store.writeDay('site',start,daySamples(),fetched,jobOptions.now);
        expect(await latest()).toEqual(daySamples().at(-1)!.timestamp);
        const next=addDaysInSiteTimezone(start,1,'America/Chicago');
        expect(await store.writeDay('site',next,[],fetched,jobOptions.now)).toEqual({status:'checked-empty'});
        expect(await latest()).toEqual(daySamples().at(-1)!.timestamp);
        expect(await latest('other')).toBeNull();
    });
    it('replaces the day only from a newer fetch, as Tesla is the source of truth',async()=>{
        const first=await store.writeDay('site',start,daySamples(3),fetched,jobOptions.now);
        const newer=new Date(+fetched+60000);
        const second=await store.writeDay('site',start,daySamples(7),newer,jobOptions.now);
        expect(second).toMatchObject({status:'written'});expect(second.revision).not.toBe(first.revision);
        expect((await pool.query('SELECT count(*)::int AS n,max(fetched_at) AS at FROM "EnergyDayArchive"')).rows[0]).toEqual({n:1,at:newer});
        const solar=async()=>(await new CompactHistoryReader(store,'America/Chicago').getRawEnergyData('site',start,end))[0].solar_power;
        expect(await solar()).toBe(7);
        // An older, slower fetch (or the same fetch retried) never overwrites the newer one.
        for(const at of [fetched,newer]) expect(await store.writeDay('site',start,daySamples(1),at,jobOptions.now)).toEqual({status:'superseded',revision:second.revision});
        expect(await solar()).toBe(7);
        expect((await pool.query('SELECT revision FROM "EnergyDayArchive"')).rows[0].revision).toBe(second.revision);
    });
    it('reports a recent short record as open for planning, and its fetch state',async()=>{
        await store.writeDay('site',start,daySamples().slice(0,287),fetched,jobOptions.now);
        expect((await new CompactHistoryReader(store,'America/Chicago').getDailyCoverage('site',start,end,'America/Chicago'))[0])
            .toMatchObject({count:287,archived:false,open:true});
        expect(await store.getDayRecordState('site',start)).toEqual({status:'open',fetchedAt:fetched});
        await store.writeDay('site',start,daySamples(),new Date(+fetched+1),jobOptions.now);
        const complete=(await new CompactHistoryReader(store,'America/Chicago').getDailyCoverage('site',start,end,'America/Chicago'))[0];
        expect(complete).toMatchObject({archived:true});expect(complete.open).toBeUndefined();
        expect(await store.getDayRecordState('site',end)).toBeNull();
    });
    it('refuses days not yet begun, foreign samples, future or invalid fetch times, and ignores an empty day',async()=>{
        await expect(store.writeDay('site',start,daySamples(),new Date(+start-1),new Date(+start-1))).rejects.toThrow();
        await expect(store.writeDay('site',start,[{...daySamples()[0],site_id:'other'}],fetched,jobOptions.now)).rejects.toThrow();
        await expect(store.writeDay('site',start,[{...daySamples()[0],timestamp:end}],fetched,jobOptions.now)).rejects.toThrow();
        await expect(store.writeDay('site',start,daySamples(),new Date(+jobOptions.now+1),jobOptions.now)).rejects.toThrow();
        await expect(store.writeDay('site',start,daySamples(),new Date(NaN),jobOptions.now)).rejects.toThrow();
        expect(await store.writeDay('site',start,[],fetched,jobOptions.now)).toEqual({status:'checked-empty'});
        // The day's record says Tesla answered it with nothing: no payload, digests, projection or summaries.
        expect((await pool.query(`SELECT status,format_version,metadata_version,sample_count,expected_slots,payload,checksum,codec,axis,payload_checksum,
            metadata_checksum,first_timestamp,last_timestamp,max_interior_gap_ms,latest_metadata,latest_checksum,attribution,attribution_complete,raw_pruned,fetched_at
            FROM "EnergyDayArchive"`)).rows).toEqual([{status:'empty',format_version:2,metadata_version:3,sample_count:0,expected_slots:288,payload:null,checksum:null,
            codec:null,axis:null,payload_checksum:null,metadata_checksum:null,first_timestamp:null,last_timestamp:null,max_interior_gap_ms:null,latest_metadata:null,
            latest_checksum:null,attribution:null,attribution_complete:false,raw_pruned:false,fetched_at:fetched}]);
        expect((await pool.query('SELECT count(*)::int AS n FROM "EnergyDaySummary"')).rows[0].n).toBe(0);
        expect(await store.getDayRecordState('site',start)).toEqual({status:'empty',fetchedAt:fetched});
    });
    describe('writeDay for open days (day record v2)',()=>{
        const samplesAt=(day:Date,count:number,solar=3,site='site')=>Array.from({length:count},(_,n)=>({site_id:site,timestamp:new Date(+day+n*300000),
            load_power:20,solar_power:solar,grid_power:n%3?10:-4,battery_power:-2,battery_soc:n%12===0?40+n/12:null}));
        it('writes today while it is in progress and replaces it from each newer fetch',async()=>{
            const reader=new CompactHistoryReader(store,'America/Chicago');
            // 06:00 local on the day: 72 samples so far.
            const morning=new Date(+start+6*3600000+90000);
            const first=await store.writeDay('site',start,samplesAt(start,72),morning,morning);
            expect(first).toMatchObject({status:'written',dayStatus:'open',attributionComplete:true});
            const row=(await pool.query('SELECT status,sample_count,expected_slots,attribution,fetched_at FROM "EnergyDayArchive"')).rows[0];
            expect(row).toEqual({status:'open',sample_count:72,expected_slots:288,fetched_at:morning,
                attribution:{timelineRevision:'current-tariff:1',segments:[{offset:0,tariffId:1,scheduleId:2}]}});
            expect(await reader.getRawEnergyData('site',start,morning)).toHaveLength(72);
            expect(await store.getLatestTimestamp('site',morning)).toEqual(new Date(+start+71*300000));
            expect((await store.getLatestEnergyData('site',morning))?.timestamp).toEqual(new Date(+start+71*300000));
            expect(await store.getLatestBatterySoc('site',start,morning)).toEqual({timestamp:new Date(+start+60*300000),value:45});
            // Coverage and billing for the day so far, from the open record.
            const window=await reader.getCycleAggregatesAndCoverage('site',start,morning,'America/Chicago');
            expect(window.coverage).toEqual([expect.objectContaining({count:72})]);
            expect(window.aggregates).toEqual([expect.objectContaining({tariff_schedule_id:2,load_power:20*72})]);
            const later=new Date(+morning+300000);
            expect(await store.writeDay('site',start,samplesAt(start,73),later,later)).toMatchObject({status:'written',dayStatus:'open'});
            expect(await store.getLatestTimestamp('site',later)).toEqual(new Date(+start+72*300000));
            // Planning still sees today as incomplete.
            expect((await EnergyRepo.countAlignedSamples([{siteId:'site',start,end}],pool)).get('site')).toBe(73);
        });
        it('records an empty interior day as checked, never a failed or unmade fetch, and settles it by age',async()=>{
            const tz='America/Chicago',day=(n:number)=>addDaysInSiteTimezone(start,n,tz),at=(d:Date,days:number)=>new Date(+d+days*86400000);
            const marker=async()=>(await pool.query(`SELECT day_start,fetched_at AS checked_at FROM "EnergyDayArchive" WHERE status='empty' ORDER BY day_start`)).rows;
            const settled=(asOf:Date)=>store.getSettledEmptyDays('site',day(0),day(4),asOf);
            // Tesla has days 0 and 2 but answers day 1, between them, with no samples.
            expect(await store.writeDay('site',day(0),samplesAt(day(0),288),at(day(1),1),at(day(1),1))).toMatchObject({status:'written'});
            expect(await store.writeDay('site',day(1),[],at(day(2),1),at(day(2),1))).toEqual({status:'checked-empty'});
            expect(await store.writeDay('site',day(2),samplesAt(day(2),288),at(day(3),1),at(day(3),1))).toMatchObject({status:'written'});
            // Planning's coverage carries each record's fetch time.
            expect((await new CompactHistoryReader(store,tz).getDailyCoverage('site',day(0),day(1),tz))[0]).toMatchObject({count:288,fetchedAt:at(day(1),1)});
            // Day 3's fetch failed (fetchDayForWrite throws before writeDay), so it has no record: never fetched.
            expect(await marker()).toEqual([{day_start:day(1),checked_at:at(day(2),1)}]);
            // Retried like an open day inside the gap-heal window, settled after it.
            expect(await settled(at(day(2),5))).toEqual([]);
            expect(await settled(at(day(2),20))).toEqual([day(1)]);
            // Planning sees every empty record with its check time, settled or not.
            expect(await store.getEmptyDays('site',day(0),day(4),at(day(2),5))).toEqual([{dayStart:day(1),fetchedAt:at(day(2),1),settled:false}]);
            expect(await store.getEmptyDays('site',day(0),day(4),at(day(2),20))).toEqual([{dayStart:day(1),fetchedAt:at(day(2),1),settled:true}]);
            // An older empty answer never moves the check back.
            expect(await store.writeDay('site',day(1),[],at(day(2),0.5),at(day(2),20))).toEqual({status:'checked-empty'});
            expect((await marker())[0].checked_at).toEqual(at(day(2),1));
            // A check made before the day ended is not Tesla's final answer.
            expect(await store.writeDay('site',day(3),[],at(day(3),0.5),at(day(3),0.5))).toEqual({status:'checked-empty'});
            expect(await settled(at(day(4),20))).toEqual([day(1)]);
            // Samples that appear later replace the empty record, even from a request made before its empty answer
            // (an empty answer after published samples is a Tesla failure).
            expect(await store.writeDay('site',day(1),samplesAt(day(1),12),at(day(2),0.75),at(day(2),21))).toMatchObject({status:'written',dayStatus:'gapped'});
            expect((await marker()).map(m=>m.day_start)).toEqual([day(3)]);
            expect(await settled(at(day(4),20))).toEqual([]);
            // An empty answer after a non-empty one is a Tesla failure: the record stays.
            expect(await store.writeDay('site',day(1),[],at(day(2),22),at(day(2),22))).toEqual({status:'empty'});
            expect((await pool.query('SELECT sample_count FROM "EnergyDayArchive" WHERE day_start=$1',[day(1)])).rows[0].sample_count).toBe(12);
            expect((await marker()).map(m=>m.day_start)).toEqual([day(3)]);
        });
        it('marks an ended short day open within the gap-heal window and gapped after it; a full day is complete',async()=>{
            const status=async()=>(await pool.query('SELECT status FROM "EnergyDayArchive"')).rows[0].status;
            const at=(days:number)=>new Date(+end+days*86400000);
            expect((await store.writeDay('site',start,samplesAt(start,200),at(1),at(1))).dayStatus).toBe('open');
            expect((await store.writeDay('site',start,samplesAt(start,200),at(15),at(15))).dayStatus).toBe('gapped');
            expect(await status()).toBe('gapped');
            const coverage=async()=>(await new CompactHistoryReader(store,'America/Chicago').getDailyCoverage('site',start,end,'America/Chicago'))[0];
            // Gapped: Tesla never had the missing samples, so planning treats the day as settled.
            expect(await coverage()).toMatchObject({count:200,archived:true});
            expect((await store.writeDay('site',start,samplesAt(start,288),at(16),at(16))).dayStatus).toBe('complete');
            expect(await coverage()).toMatchObject({count:288,archived:true});
        });
        it.each([
            ['fall-back',new Date('2026-11-01T05:00:00Z'),300,[{offset:0,tariffId:3,scheduleId:5},{offset:1020,tariffId:3,scheduleId:4},{offset:1320,tariffId:3,scheduleId:6}]],
            ['spring-forward',new Date('2026-03-08T06:00:00Z'),276,[{offset:0,tariffId:3,scheduleId:5},{offset:900,tariffId:3,scheduleId:4},{offset:1200,tariffId:3,scheduleId:6}]],
        ])('attributes the %s DST day by minutes from midnight',async(_,day,slots,segments)=>{
            await pool.query(`INSERT INTO "Site" VALUES ('tou','America/Chicago') ON CONFLICT DO NOTHING;
                INSERT INTO "Tariff" (id,site_id,name,updated) VALUES (3,'tou','TOU',now()) ON CONFLICT DO NOTHING;
                INSERT INTO "TariffSeason" VALUES (3,3,'All',1,1,12,31,.2,.04) ON CONFLICT DO NOTHING;
                INSERT INTO "TariffSchedule" VALUES (4,3,'Peak',.4,.04,0,6,16,21,0,0),(5,3,'Off',.1,.04,0,6,0,16,0,0),(6,3,'Late',.1,.04,0,6,21,24,0,0) ON CONFLICT DO NOTHING;`);
            const dayEnd=addDaysInSiteTimezone(day,1,'America/Chicago');
            const samples=samplesAt(day,slots,3,'tou');
            expect(await store.writeDay('tou',day,samples,dayEnd,dayEnd)).toMatchObject({status:'written',dayStatus:'complete',attributionComplete:true});
            const row=(await pool.query('SELECT expected_slots,attribution FROM "EnergyDayArchive" WHERE site_id=$1',['tou'])).rows[0];
            expect(row).toEqual({expected_slots:slots,attribution:{timelineRevision:'current-tariff:3',segments}});
            const reader=new CompactHistoryReader(store,'America/Chicago');
            const rows=await reader.getRawEnergyData('tou',day,dayEnd);
            expect(rows).toHaveLength(slots);
            expect(rows.filter(r=>r.tariff_schedule_id===4)).toHaveLength(60);
            const result=await reader.getCycleAggregatesAndCoverage('tou',day,dayEnd,'America/Chicago');
            expect(result.coverage).toEqual([expect.objectContaining({count:slots,archived:true})]);
            expect(result.aggregates.map(a=>[a.tariff_schedule_id,a.load_power])).toEqual([[4,20*60],[5,20*(segments[1].offset/5)],[6,20*36]]);
        });
        it('ignores non-current tariff versions when deriving segments',async()=>{
            await pool.query(`INSERT INTO "Tariff" (id,site_id,name,updated,is_current) VALUES (9,'site','Old',now(),false) ON CONFLICT DO NOTHING`);
            try {
                await store.writeDay('site',start,samplesAt(start,10),fetched,jobOptions.now);
                expect((await pool.query('SELECT attribution FROM "EnergyDayArchive"')).rows[0].attribution.timelineRevision).toBe('current-tariff:1');
            } finally {await pool.query('DELETE FROM "Tariff" WHERE id=9');}
        });
        it('never replaces stored SOC when the SOE request fails',async()=>{
            const {Importer}=await import('../importer');
            const {fetchDayForWrite}=await import('./compact-day-fetch');
            await store.writeDay('site',start,samplesAt(start,288),fetched,jobOptions.now);
            const before=(await pool.query('SELECT revision,latest_metadata FROM "EnergyDayArchive"')).rows[0];
            const client={getEnergyHistory:async()=>[{timestamp:start.toISOString(),solar_power:1,battery_power:0,grid_power:0,load_power:1}],
                getSoeHistory:async()=>{throw new Error('SOE unavailable');}};
            const site={id:'site',timezone:'America/Chicago',tariffs:[]} as unknown as Parameters<typeof fetchDayForWrite>[1];
            await expect(fetchDayForWrite(new Importer(client as never),site,start,jobOptions.now)).rejects.toThrow('SOE unavailable');
            expect((await pool.query('SELECT revision,latest_metadata FROM "EnergyDayArchive"')).rows[0]).toEqual(before);
            expect(before.latest_metadata.soc).toEqual({timestamp:+start+276*300000,value:63});
        });
        it('reads historical freshness and SOC from before a record\'s latest projection',async()=>{
            await store.writeDay('site',start,samplesAt(start,288),fetched,jobOptions.now);
            // The next day's first stored sample is at 00:05, after an as-of of midnight.
            await store.writeDay('site',end,samplesAt(end,100).slice(1),fetched,jobOptions.now);
            expect(await store.getLatestTimestamp('site',end)).toEqual(new Date(+end-300000));
            expect(await store.getLatestTimestamp('site',new Date(+start-1))).toBeNull();
            // SOC at 02:00 and later; a 02:30 cutoff must not skip the day for its later projection.
            expect(await store.getLatestBatterySoc('site',start,new Date(+start+30*300000))).toEqual({timestamp:new Date(+start+24*300000),value:42});
            expect(await store.getLatestBatterySoc('site',new Date(+start+25*300000),new Date(+start+30*300000))).toBeNull();
        });
    });
    describe('empty day records (Tesla answered a day with no samples)',()=>{
        const tz='America/Chicago',day=(n:number)=>addDaysInSiteTimezone(start,n,tz);
        const full=(d:Date,site='site')=>Array.from({length:288},(_,n)=>({site_id:site,timestamp:new Date(+d+n*300000),
            load_power:20,solar_power:3,grid_power:10,battery_power:-2,battery_soc:n%12===0?50:null}));
        const after=(d:Date,hours:number)=>new Date(+d+hours*3600000);
        const reader=()=>new CompactHistoryReader(store,tz);
        const emptyRow=(overrides:Record<string,unknown>={})=>({site_id:'site',day_start:start,day_end:end,revision:randomUUID(),format_version:2,
            sample_count:0,expected_slots:288,attribution_complete:false,metadata_version:3,raw_pruned:false,status:'empty',fetched_at:now,...overrides});
        const insertRow=async(row:Record<string,unknown>)=>{
            const keys=Object.keys(row);
            await pool.query(`INSERT INTO "EnergyDayArchive" (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
        };
        it('never takes the latest sample, SOC or freshness from an empty newest day',async()=>{
            await store.writeDay('site',day(0),full(day(0)),after(day(1),1),after(day(1),1));
            const asOf=after(day(1),12);
            expect(await store.writeDay('site',day(1),[],after(day(1),11),asOf)).toEqual({status:'checked-empty'});
            const last=new Date(+day(0)+287*300000);
            expect((await pool.query<{at:Date|null}>(`SELECT ${latestStoredSampleSql('$1')} AS at`,['site'])).rows[0].at).toEqual(last);
            expect(await store.getLatestTimestamp('site',asOf)).toEqual(last);
            expect((await store.getLatestEnergyData('site',asOf))?.timestamp).toEqual(last);
            expect(await store.getLatestBatterySoc('site',day(0),asOf)).toEqual({timestamp:new Date(+day(0)+276*300000),value:50});
            // Only empty records: no data, nothing latest.
            expect(await store.writeDay('other',day(1),[],after(day(1),11),asOf)).toEqual({status:'checked-empty'});
            expect(await store.hasData('other')).toBe(false);
            expect(await store.hasData('site')).toBe(true);
            expect((await pool.query<{at:Date|null}>(`SELECT ${latestStoredSampleSql('$1')} AS at`,['other'])).rows[0].at).toBeNull();
            expect(await store.getLatestTimestamp('other',asOf)).toBeNull();
            expect(await store.getLatestEnergyData('other',asOf)).toBeNull();
            expect(await store.getLatestBatterySoc('other',day(0),asOf)).toBeNull();
        });
        it('reads charts, billing and coverage over a span containing an empty day as checked, no data',async()=>{
            for(const n of [0,2]) await store.writeDay('site',day(n),full(day(n)),after(day(n+1),1),jobOptions.now);
            expect(await store.writeDay('site',day(1),[],after(day(2),1),jobOptions.now)).toEqual({status:'checked-empty'});
            const priced=(rows:ReturnType<typeof full>)=>rows.map(r=>({...r,tariff_id:1,tariff_schedule_id:2}));
            const expected=priced([...full(day(0)),...full(day(2))]);
            expect(await reader().getRawEnergyData('site',day(0),day(3))).toEqual(expected);
            expect((await store.readSnapshot('site',day(0),day(3))).days.map(d=>d.start)).toEqual([day(0),day(2)]);
            const whole=await reader().getCycleAggregatesAndCoverage('site',day(0),day(3),tz);
            expect(whole.coverage.map(c=>[c.localDayKey,c.count,c.archived])).toEqual([['2026-01-01',288,true],['2026-01-03',288,true]]);
            expect([...new Set(whole.aggregates.map(a=>+a.day))]).toEqual([+day(0),+day(2)]);
            // Partial windows take the detail path, which must skip the empty day too.
            const partial=await reader().getCycleAggregatesAndCoverage('site',after(day(1),6),after(day(2),6),tz);
            expect(partial.coverage.map(c=>[c.localDayKey,c.count])).toEqual([['2026-01-03',72]]);
            expect(await reader().getRawEnergyData('site',after(day(1),6),after(day(2),6))).toEqual(priced(full(day(2)).slice(0,72)));
            expect((await reader().getBucketedEnergyData('site',day(0),day(3))).length).toBeGreaterThan(0);
            expect((await EnergyRepo.countAlignedSamples([{siteId:'site',start:day(0),end:day(3)}],pool)).get('site')).toBe(576);
        });
        it('keeps the empty shape exact and every other record holding samples',async()=>{
            await insertRow(emptyRow());
            await expect(pool.query(`INSERT INTO "EnergyDaySummary" VALUES ('site',$1,(SELECT revision FROM "EnergyDayArchive"),1,2,0,0,0,0,0,0,0,0,1)`,[start]))
                .rejects.toThrow('An empty day record has no summaries');
            await pool.query('TRUNCATE "EnergyDayArchive" CASCADE');
            for(const overrides of [{payload:Buffer.from('x')},{checksum:'0'.repeat(64)},{codec:'brotli'},{axis:'grid'},{payload_checksum:'0'.repeat(64)},
                {sample_count:1},{expected_slots:287},{format_version:1},{metadata_version:2},{fetched_at:null},{raw_pruned:true},{attribution_complete:true},
                {attribution:JSON.stringify({timelineRevision:'x',segments:[]})},{status:'open'},{status:null}])
                await expect(insertRow(emptyRow(overrides))).rejects.toThrow(/violates (check|not-null) constraint/);
        });
    });
    describe('timezone changes (day records are keyed to the site timezone)',()=>{
        const utcDay=(iso:string)=>new Date(`${iso}T00:00:00Z`);
        const samples=(from:Date,count:number)=>Array.from({length:count},(_,n)=>({site_id:'moved',timestamp:new Date(+from+n*300000),
            load_power:20+n%7,solar_power:n%5,grid_power:(n%9)-4.5,battery_power:(n%3)-1,battery_soc:n%4===0?40+n/10:null}));
        const rows=async()=>(await pool.query(`SELECT day_start,day_end,sample_count,expected_slots,status,fetched_at,raw_pruned,attribution,
            public.verify_compact_day_metadata(site_id,day_start,false) AS verified FROM "EnergyDayArchive" WHERE site_id='moved' AND status IS DISTINCT FROM 'empty' ORDER BY day_start`)).rows;
        const later=new Date('2026-12-01T00:00:00Z');
        beforeAll(async()=>{
            await pool.query(`INSERT INTO "Site" VALUES ('moved','UTC') ON CONFLICT DO NOTHING;
                INSERT INTO "Tariff" (id,site_id,name,updated) VALUES (9,'moved','TOU',now()) ON CONFLICT DO NOTHING;
                INSERT INTO "TariffSeason" VALUES (9,9,'All',1,1,12,31,.2,.04) ON CONFLICT DO NOTHING;
                INSERT INTO "TariffSchedule" VALUES (10,9,'Peak',.4,.04,0,6,16,21,0,0),(11,9,'Off',.1,.04,0,6,0,16,0,0),(12,9,'Late',.1,.04,0,6,21,24,0,0) ON CONFLICT DO NOTHING;`);
        });
        beforeEach(async()=>{await pool.query(`DELETE FROM "EnergyDayArchive" WHERE site_id='moved'`);await pool.query(`UPDATE "Site" SET timezone='UTC' WHERE id='moved'`);});
        it('keeps a reported timezone back while day records exist, instead of failing the site refresh',async()=>{
            const {UPSERT_SITE_SQL}=await import('../site-upsert-sql');
            await pool.query(`ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS utility text, ADD COLUMN IF NOT EXISTS updated timestamptz,
                ADD COLUMN IF NOT EXISTS installed timestamptz, ADD COLUMN IF NOT EXISTS json jsonb`);
            const upsert=async(timezone:string)=>(await pool.query(UPSERT_SITE_SQL,['moved','Moved','Utility',later,timezone,'{}',true])).rows[0].timezone;
            await store.writeDay('moved',utcDay('2026-10-31'),samples(utcDay('2026-10-31'),288),later,later);
            expect(await upsert('America/Chicago')).toBe('UTC');
            expect((await rows())).toHaveLength(1);
            // An empty record is a record too: the stored timezone stays.
            await pool.query(`DELETE FROM "EnergyDayArchive" WHERE site_id='moved'`);
            expect(await store.writeDay('moved',utcDay('2026-10-31'),[],later,later)).toEqual({status:'checked-empty'});
            expect(await upsert('America/Chicago')).toBe('UTC');
            // A direct change is refused by the trigger rather than dropping the only copy.
            await expect(pool.query(`UPDATE "Site" SET timezone='America/Chicago' WHERE id='moved'`)).rejects.toThrow('keyed to its current timezone');
            // With no day record the change goes through.
            await pool.query(`DELETE FROM "EnergyDayArchive" WHERE site_id='moved'`);
            expect(await upsert('America/Chicago')).toBe('America/Chicago');
        });
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
        for(const signature of ['public.verify_compact_latest_metadata(text,timestamptz)','public.verify_compact_day_metadata(text,timestamptz,boolean)']) {
            const grants=await pool.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,has_function_privilege('authenticated',$1,'EXECUTE') AS authenticated,has_function_privilege('service_role',$1,'EXECUTE') AS service`,[signature]);
            expect(grants.rows[0]).toEqual({anon:false,authenticated:false,service:true});
        }
    });
    describe('day record v2 schema',()=>{
        const segments=[{offset:0,tariffId:1,scheduleId:2},{offset:480,tariffId:1,scheduleId:null}];
        const samples=[0,1,2,100,101].map(i=>({site_id:'site',timestamp:new Date(+start+i*300000),load_power:20+i,solar_power:3,grid_power:i%2?-5:10,battery_power:-2,battery_soc:i%2?50:null}));
        const insertV2=async(overrides:Record<string,unknown>={},attribution:DayAttribution={timelineRevision:'current-tariff:1',segments})=>{
            const archive=encodeDaySamples(samples,start,end,'brotli');
            const meta=buildDayMetadataV3(samples,attribution,start,end);
            const row={site_id:'site',day_start:start,day_end:end,revision:randomUUID(),format_version:2,codec:archive.codec,axis:archive.axis,checksum:archive.sha256,
                payload:archive.data,sample_count:meta.sampleCount,expected_slots:archive.expectedSlots,attribution_complete:meta.attributionComplete,
                first_timestamp:meta.first,last_timestamp:meta.last,max_interior_gap_ms:meta.maxInteriorGapMs,metadata_checksum:meta.checksum,metadata_version:3,
                attribution:JSON.stringify(meta.attribution),status:'open',fetched_at:now,raw_pruned:true,...overrides};
            const keys=Object.keys(row);
            await pool.query(`INSERT INTO "EnergyDayArchive" (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
            for(const s of meta.summaries) await pool.query(`INSERT INTO "EnergyDaySummary" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                ['site',start,row.revision,s.tariff_id,s.tariff_schedule_id,s.load_power,s.solar_power,s.grid_power,s.battery_power,
                    s.sample_import_wh,s.sample_export_wh,s.sample_charge_wh,s.sample_discharge_wh,s.sample_count]);
            return meta;
        };
        const verify=(billing=false)=>pool.query<{ok:boolean}>('SELECT public.verify_compact_day_metadata($1,$2,$3) AS ok',['site',start,billing]);
        it('verifies the v3 digest, attribution included, inside PostgreSQL',async()=>{
            const meta=await insertV2();
            expect(meta.attributionComplete).toBe(false);
            expect((await verify()).rows[0].ok).toBe(true);
            await expect(verify(true)).rejects.toThrow('Incomplete tariff attribution');
            for(const tamper of [`jsonb_set(attribution,'{segments,1,offset}','485')`,`jsonb_set(attribution,'{segments,1,scheduleId}','2')`,
                `jsonb_set(attribution,'{timelineRevision}','"current-tariff:9"')`,`jsonb_set(attribution,'{segments}',(attribution->'segments')-1)`]) {
                await pool.query(`UPDATE "EnergyDayArchive" SET attribution=${tamper}`);
                await expect(verify()).rejects.toThrow('Day metadata mismatch');
                await pool.query(`UPDATE "EnergyDayArchive" SET attribution=$1`,[JSON.stringify(meta.attribution)]);
                expect((await verify()).rows[0].ok).toBe(true);
            }
        });
        it('passes billing verification for a fully attributed v2 day',async()=>{
            await insertV2({},{timelineRevision:'current-tariff:1',segments:[{offset:0,tariffId:1,scheduleId:2}]});
            expect((await verify(true)).rows[0].ok).toBe(true);
        });
        it.each([
            ['an unknown status',{status:'stale'}],
            ['complete while short of slots',{status:'complete'}],
            ['a v2 record without status',{status:null}],
            ['a v2 record without fetched_at',{fetched_at:null}],
            ['a v2 record on metadata 2',{metadata_version:2}],
            ['metadata 3 without attribution',{attribution:null}],
            ['an attribution without segments',{attribution:JSON.stringify({timelineRevision:'x'})}],
            ['format 3',{format_version:3}],
        ])('rejects %s',async(_,overrides)=>{
            await expect(insertV2(overrides)).rejects.toThrow(/violates check constraint/);
        });
    });
});
