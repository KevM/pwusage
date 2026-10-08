/** Disposable local PostgreSQL measurements. Never connects to the source URL. */
import { stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import type { EnergyData, Tariff, TariffSchedule } from '../db-types';
import { decodeDay, encodeDay, rollupDay, type DayArchive } from './compact-energy';
import { auditTariffAttribution } from './compact-tariff-audit';
interface StorageDay { rows: EnergyData[]; start: Date; end: Date; timezone: string; tariffs: Tariff[]; schedules: TariffSchedule[] }
const tables = ['archive', 'schedule_rollup', 'period_rollup', 'raw_baseline'] as const;
interface Size { table: string; rows: number; heap_bytes: number; index_bytes: number; total_bytes: number; toast_and_other_bytes: number }

export async function measureStorage(days: StorageDay[], socket: string) {
    if (!/^\/private\/tmp\/compact-energy-pg-[a-zA-Z0-9-]+$/.test(socket) || ((await stat(socket)).mode & 0o077) !== 0) throw new Error('Storage target must be a private disposable local socket');
    const pool = new Pool({ host: socket, port: 55439, user: process.env.USER, database: 'postgres', max: 1 });
    const client = await pool.connect();
    const schema = `compact_benchmark_${Date.now()}`;
    let unresolvedDays = 0; let records = 0;
    try {
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET search_path TO ${schema}, pg_catalog`);
        await client.query(`DO $$ BEGIN
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
        END $$`);
        await client.query(`CREATE TABLE archive (
            site_id text NOT NULL, day_start timestamptz NOT NULL, day_end timestamptz NOT NULL,
            format_version smallint NOT NULL, codec text NOT NULL, checksum bytea NOT NULL CHECK(octet_length(checksum)=32),
            samples integer NOT NULL, expected_slots integer NOT NULL, attribution_complete boolean NOT NULL, payload bytea NOT NULL,
            PRIMARY KEY(site_id, day_start));
            ALTER TABLE archive ALTER COLUMN payload SET STORAGE EXTERNAL;
            CREATE TABLE schedule_rollup (
                site_id text NOT NULL, day_start timestamptz NOT NULL, tariff_id integer NOT NULL, schedule_id integer,
                home_wh double precision NOT NULL, solar_wh double precision NOT NULL, grid_wh double precision NOT NULL,
                battery_wh double precision NOT NULL, sample_count integer NOT NULL);
            CREATE UNIQUE INDEX schedule_rollup_key ON schedule_rollup(site_id,day_start,tariff_id,schedule_id) NULLS NOT DISTINCT;
            CREATE TABLE period_rollup (
                site_id text NOT NULL, day_start timestamptz NOT NULL, tariff_id integer NOT NULL, period_name text,
                buy_rate double precision, sell_rate double precision,
                home_wh double precision NOT NULL, solar_wh double precision NOT NULL, grid_wh double precision NOT NULL,
                battery_wh double precision NOT NULL, sample_count integer NOT NULL);
            CREATE UNIQUE INDEX period_rollup_key ON period_rollup(site_id,day_start,tariff_id,period_name,buy_rate,sell_rate) NULLS NOT DISTINCT;
            CREATE TABLE raw_baseline (
                id serial PRIMARY KEY, timestamp timestamptz NOT NULL, site_id text NOT NULL, tariff_id integer NOT NULL, tariff_schedule_id integer,
                load_power double precision NOT NULL, solar_power double precision NOT NULL, grid_power double precision NOT NULL,
                battery_power double precision NOT NULL, battery_soc double precision);
            CREATE UNIQUE INDEX raw_timestamp_site ON raw_baseline(timestamp,site_id);
            CREATE INDEX raw_site_timestamp ON raw_baseline(site_id,timestamp);
            CREATE INDEX raw_tariff ON raw_baseline(tariff_id);
            CREATE INDEX raw_schedule ON raw_baseline(tariff_schedule_id);`);
        for (const table of tables) await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
            REVOKE ALL ON ${table} FROM PUBLIC, anon, authenticated;
            GRANT ALL ON ${table} TO service_role;`);
        await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC, anon, authenticated; GRANT USAGE ON SCHEMA ${schema} TO service_role;
            GRANT ALL ON SEQUENCE raw_baseline_id_seq TO service_role`);
        for (const day of days) {
            const archive = encodeDay(day.rows, day.start, day.end, 'brotli');
            const audit = auditTariffAttribution(day.rows, day.timezone, day.tariffs, day.schedules);
            if (audit.unresolvedSamples) unresolvedDays++;
            await client.query('INSERT INTO archive VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9)', [day.rows[0].site_id, day.start, day.end,
                archive.codec, Buffer.from(archive.sha256, 'hex'), day.rows.length, archive.expectedSlots, audit.unresolvedSamples === 0, archive.data]);
            for (const r of rollupDay(audit.rows, day.start)) await client.query('INSERT INTO schedule_rollup VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                [r.site_id, day.start, r.tariff_id, r.tariff_schedule_id, r.load_power, r.solar_power, r.grid_power, r.battery_power, r.sample_count]);
            for (const r of audit.periods) await client.query('INSERT INTO period_rollup VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
                [day.rows[0].site_id, day.start, r.tariff_id, r.period_name, r.buy_rate, r.sell_rate, r.home_wh, r.solar_wh, r.grid_wh, r.battery_wh, r.sample_count]);
            // Unknown attribution retains all energy, with null pricing rather
            // than invented rates. It never disappears from the size benchmark.
            const unresolved = new Map<number, EnergyData[]>();
            for (const row of audit.unresolvedRows) { const group = unresolved.get(row.tariff_id) ?? []; group.push(row); unresolved.set(row.tariff_id, group); }
            for (const [tariffId, rows] of unresolved) {
                const sum = (key: 'load_power' | 'solar_power' | 'grid_power' | 'battery_power') => rows.reduce((n, r) => n + r[key], 0);
                await client.query('INSERT INTO period_rollup VALUES ($1,$2,$3,NULL,NULL,NULL,$4,$5,$6,$7,$8)',
                    [day.rows[0].site_id, day.start, tariffId, sum('load_power'), sum('solar_power'), sum('grid_power'), sum('battery_power'), rows.length]);
            }
            const totals = await client.query<{ home: number; solar: number; grid: number; battery: number; count: string }>(`SELECT SUM(home_wh) AS home,SUM(solar_wh) AS solar,SUM(grid_wh) AS grid,SUM(battery_wh) AS battery,SUM(sample_count)::text AS count
                FROM period_rollup WHERE site_id=$1 AND day_start=$2`, [day.rows[0].site_id, day.start]);
            const t = totals.rows[0];
            for (const [key, actual] of [['load_power', t.home], ['solar_power', t.solar], ['grid_power', t.grid], ['battery_power', t.battery]] as const) {
                const expected = day.rows.reduce((sum, r) => sum + r[key], 0);
                if (Math.abs(expected - actual) > 1e-9 * Math.max(1, Math.abs(expected), Math.abs(actual))) throw new Error('Stored totals do not reconcile');
            }
            if (Number(t.count) !== day.rows.length) throw new Error('Stored coverage does not reconcile');
            const raw = day.rows.map(r => [r.timestamp.toISOString(), r.site_id, r.tariff_id, r.tariff_schedule_id, r.load_power, r.solar_power, r.grid_power, r.battery_power, r.battery_soc]);
            await client.query(`INSERT INTO raw_baseline(timestamp,site_id,tariff_id,tariff_schedule_id,load_power,solar_power,grid_power,battery_power,battery_soc)
                SELECT (r->>0)::timestamptz,r->>1,(r->>2)::integer,(r->>3)::integer,(r->>4)::double precision,(r->>5)::double precision,
                (r->>6)::double precision,(r->>7)::double precision,(r->>8)::double precision FROM jsonb_array_elements($1::jsonb) r`, [JSON.stringify(raw)]);
            const saved = await client.query<{ payload: Buffer; checksum: Buffer; codec: DayArchive['codec'] }>('SELECT payload,checksum,codec FROM archive WHERE site_id=$1 AND day_start=$2', [day.rows[0].site_id, day.start]);
            if (!isDeepStrictEqual(decodeDay({ ...archive, codec: saved.rows[0].codec, data: saved.rows[0].payload, sha256: saved.rows[0].checksum.toString('hex') }), day.rows)) throw new Error('Stored archive does not roundtrip');
            records += day.rows.length;
        }
        const sizes: Size[] = [];
        for (const table of tables) {
            await client.query(`ANALYZE ${table}`);
            const result = await client.query<{ heap: string; indexes: string; total: string; rows: string }>(`SELECT
                pg_relation_size($1::regclass)::text AS heap, pg_indexes_size($1::regclass)::text AS indexes,
                pg_total_relation_size($1::regclass)::text AS total, (SELECT count(*) FROM ${table})::text AS rows`, [`${schema}.${table}`]);
            const r = result.rows[0]; sizes.push({ table, rows: Number(r.rows), heap_bytes: Number(r.heap), index_bytes: Number(r.indexes), total_bytes: Number(r.total),
                toast_and_other_bytes: Number(r.total) - Number(r.heap) - Number(r.indexes) });
        }
        const sum = (name: string) => sizes.find(s => s.table === name)!.total_bytes;
        const annual = (bytes: number) => bytes / days.length * 365 / 1e6;
        const security = await client.query<{ tablename: string; rowsecurity: boolean }>('SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname=$1', [schema]);
        const permissions = await client.query<{ forbidden_grants: number }>(`SELECT count(*)::integer AS forbidden_grants FROM information_schema.role_table_grants
            WHERE table_schema=$1 AND grantee IN ('PUBLIC','anon','authenticated')`, [schema]);
        if (security.rows.some(r => !r.rowsecurity) || permissions.rows[0].forbidden_grants !== 0) throw new Error('Fixture RLS/grants failed');
        return { serverVersion: (await client.query<{ version: string }>("SELECT current_setting('server_version') AS version")).rows[0].version,
            measuredDays: days.length, measuredSamples: records, unresolvedDays, sizes, rlsAndGrantsVerified: true, databaseRoundtripVerified: true, energyAndCoverageReconciled: true,
            annualArchiveMB: annual(sum('archive')), annualArchivePlusScheduleRollupMB: annual(sum('archive') + sum('schedule_rollup')),
            annualArchivePlusPeriodRollupMB: annual(sum('archive') + sum('period_rollup')), annualRawBaselineMB: annual(sum('raw_baseline')),
            allocationSavingPercent: 100 * (1 - (sum('archive') + sum('period_rollup')) / sum('raw_baseline')),
            limitations: 'Small fixed read-only-source sample copied into isolated PG18; annual projections assume this mix repeats. Local raw baseline has five specified indexes and no parent/FK metadata. Relation totals include page allocation, indexes and TOAST. Partially attributed days retain incomplete status; no source rows were modified.' };
    } finally { client.release(); await pool.end(); }
}
