import 'dotenv/config';
import type { QueryResultRow } from 'pg';
import { assertRetentionTarget } from './history-retention-cli';
import type { RetentionDatabase, RetentionQueryable } from '../src/lib/history-retention-repo';

async function run(): Promise<void> {
    if (process.argv.includes('--help')) {
        console.log('Rollback-only fixture: npx tsx scripts/verify-history-retention.ts --env dev|local\nUses temporary session-local tables. Production targets are refused.');
        return;
    }
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== '--env' || (argv[1] !== 'dev' && argv[1] !== 'local')) throw new Error('Explicit dev or local target is required');
    assertRetentionTarget(argv[1], process.env.DATABASE_URL);
    const { pool } = await import('../src/lib/db');
    const { HistoryRetentionRepo } = await import('../src/lib/history-retention-repo');
    const { HistoryRetentionService } = await import('../src/lib/history-retention-service');
    const { EnergyRepo } = await import('../src/lib/energy-repo');
    const { LoadTagRepo } = await import('../src/lib/load-tag-repo');
    const client = await pool.connect();
    const assert = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
    try {
        await client.query('BEGIN');
        await client.query(`
            CREATE TEMP TABLE "User" (id text PRIMARY KEY, history_retention_days integer NOT NULL CHECK (history_retention_days IN (90,365)), history_retention_grace_until timestamptz, history_retention_transition_pending boolean NOT NULL) ON COMMIT DROP;
            CREATE TEMP TABLE "Site" (id text PRIMARY KEY, user_id text REFERENCES "User"(id), timezone text) ON COMMIT DROP;
            CREATE TEMP TABLE "Tariff" (id bigint PRIMARY KEY, site_id text REFERENCES "Site"(id) ON DELETE CASCADE, version integer, is_current boolean, name text) ON COMMIT DROP;
            CREATE TEMP TABLE "TariffSeason" (id bigint PRIMARY KEY, tariff_id bigint REFERENCES "Tariff"(id) ON DELETE CASCADE, name text, buy_rate double precision) ON COMMIT DROP;
            CREATE TEMP TABLE "TariffSchedule" (id bigint PRIMARY KEY, season_id bigint REFERENCES "TariffSeason"(id) ON DELETE CASCADE, name text, buy_rate double precision) ON COMMIT DROP;
            CREATE TEMP TABLE "EnergyData" (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, site_id text REFERENCES "Site"(id), tariff_id bigint REFERENCES "Tariff"(id), timestamp timestamptz, load_power double precision, solar_power double precision, grid_power double precision, battery_power double precision, battery_soc double precision, tariff_schedule_id bigint REFERENCES "TariffSchedule"(id), UNIQUE(timestamp,site_id)) ON COMMIT DROP;
            CREATE TEMP TABLE "LoadTag" (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, site_id text REFERENCES "Site"(id), start_time timestamptz, end_time timestamptz, tag text) ON COMMIT DROP;
            INSERT INTO "User" VALUES ('u90',90,NULL,FALSE),('u365',365,NULL,FALSE),('ugrace',90,'2026-10-15T18:00:00Z',FALSE),('uexpired',90,'2026-10-01T18:00:00Z',FALSE),('upending',90,NULL,TRUE);
            INSERT INTO "Site" VALUES ('s90','u90','UTC'),('s365','u365','America/Chicago'),('sgrace','ugrace','UTC'),('sexpired','uexpired','UTC'),('spending','upending','UTC'),('sorphan',NULL,'UTC');
            INSERT INTO "Tariff" VALUES (1,'s90',1,FALSE,'Historical'),(2,'s90',2,TRUE,'Current'),(3,'s90',0,FALSE,'Never referenced'),(4,'s365',1,TRUE,'Extended'),(5,'sgrace',1,TRUE,'Grace'),(6,'sexpired',1,TRUE,'Expired grace'),(7,'spending',1,TRUE,'Pending'),(8,'sorphan',1,TRUE,'Orphan');
            INSERT INTO "TariffSeason" SELECT id,id,'Season '||id,0.23+id/100.0 FROM "Tariff";
            INSERT INTO "TariffSchedule" SELECT id,id,'Schedule '||id,0.31+id/100.0 FROM "Tariff";
            INSERT INTO "EnergyData" (site_id,tariff_id,timestamp,tariff_schedule_id) VALUES
                ('s90',1,'2026-06-01T00:00:00Z',1),('s90',1,'2026-07-03T00:00:00Z',1),('s90',2,'2026-08-01T00:00:00Z',2),
                ('s365',4,'2025-01-01T00:00:00Z',4),('s365',4,'2026-06-01T00:00:00Z',4),('sgrace',5,'2026-06-01T00:00:00Z',5),
                ('sexpired',6,'2026-06-01T00:00:00Z',6),('spending',7,'2026-06-01T00:00:00Z',7),('sorphan',8,'2026-06-01T00:00:00Z',8);
            INSERT INTO "LoadTag" (site_id,start_time,end_time,tag) VALUES
                ('s90','2026-06-01','2026-06-02','Expired'),('s90','2026-07-02','2026-07-03','Ends at cutoff'),('s90','2026-08-01','2026-08-02','Current'),
                ('s365','2025-01-01','2025-01-02','Ancient'),('sgrace','2026-06-01','2026-06-02','Grace'),('sexpired','2026-06-01','2026-06-02','Expired grace');
        `);
        // Guard every table name before any cleanup. Session temp tables shadow public tables.
        const guard = await client.query<{ safe: boolean }>(`
            SELECT bool_and(to_regclass(quote_ident(name)) = to_regclass('pg_temp.' || quote_ident(name))) AS safe
            FROM unnest(ARRAY['User','Site','EnergyData','LoadTag','Tariff','TariffSeason','TariffSchedule']) name
        `);
        assert(guard.rows[0].safe, 'Fixture shadow-table guard failed');
        // Translate nested batch transactions to savepoints so the outer fixture always rolls back.
        const query: RetentionQueryable['query'] = async <Row extends QueryResultRow>(sql: string, params?: unknown[]) => {
            if (sql === 'BEGIN') return client.query<Row>('SAVEPOINT retention_batch');
            if (sql === 'COMMIT') return client.query<Row>('RELEASE SAVEPOINT retention_batch');
            if (sql === 'ROLLBACK') { await client.query('ROLLBACK TO SAVEPOINT retention_batch'); return client.query<Row>('RELEASE SAVEPOINT retention_batch'); }
            return client.query<Row>(sql, params);
        };
        const db: RetentionDatabase = { query, connect: async () => ({ query, release: () => undefined }) };
        const repo = new HistoryRetentionRepo(db);
        const energy = new EnergyRepo();
        const service = new HistoryRetentionService({ repo, energy, tags: new LoadTagRepo() });
        const now = new Date('2026-10-01T18:00:00Z');
        const blocked = await service.run({ now, apply: true });
        assert(!blocked.enabled && blocked.deleted.energy === 0 && blocked.deleted.tags === 0, 'Pending transition gate failed');
        await client.query(`UPDATE "User" SET history_retention_transition_pending=FALSE, history_retention_grace_until='2026-10-31T18:00:00Z' WHERE id='upending'`);
        const snapshot = async () => (await client.query<{ value: unknown }>(`
            SELECT jsonb_build_object(
                'tariffs',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "Tariff" t),
                'seasons',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "TariffSeason" t),
                'schedules',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "TariffSchedule" t),
                'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "User" t),
                'sites',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "Site" t)) AS value
        `)).rows[0].value;
        const before = JSON.stringify(await snapshot());
        const initialRows = (await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM "EnergyData"')).rows[0].count;
        let rollbackSeen = false;
        try {
            await repo.withLockedSite('s90', async (_site, transaction) => {
                await energy.deleteExpiredBatch('s90', new Date('2026-07-03T00:00:00Z'), 1000, transaction);
                throw new Error('intentional fixture rollback');
            });
        } catch (error) { if (error instanceof Error && error.message === 'intentional fixture rollback') rollbackSeen = true; else throw error; }
        assert(rollbackSeen, 'Batch rollback was not exercised');
        assert((await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM "EnergyData"')).rows[0].count === initialRows, 'Batch rollback lost energy rows');
        const preview = await service.run({ now });
        assert(preview.sites.reduce((sum, site) => sum + site.eligibleEnergy, 0) === 3, 'Energy preview predicate failed');
        assert(preview.sites.reduce((sum, site) => sum + site.eligibleTags, 0) === 3, 'Tag preview predicate failed');
        const report = await service.run({ now, apply: true });
        assert(report.deleted.energy === 3 && report.deleted.tags === 3, 'Cleanup did not match preview');
        assert(report.skippedSites.includes('sorphan'), 'Unowned site was not reported');
        assert(!report.workRemaining, 'Cleanup left eligible fixture data');
        assert(before === JSON.stringify(await snapshot()), 'A tariff, season, schedule, user, or site changed');
        const repeat = await service.run({ now, apply: true });
        assert(repeat.deleted.energy === 0 && repeat.deleted.tags === 0 && !repeat.workRemaining, 'Cleanup is not idempotent');
        console.log(JSON.stringify({ result: 'PASS', energyDeleted: 3, tagsDeleted: 3, exactCutoffPreserved: true, unusedTariffsPreserved: true, allTariffAndParentValuesUnchanged: true, pendingGate: true, rollbackVerified: true, idempotent: true, publicTablesModified: false }));
    } finally {
        try { await client.query('ROLLBACK'); } finally { client.release(); await pool.end(); }
    }
}
run().catch((error: unknown) => {
    // Internal assertions are safe; avoid dumping connection strings or driver error details.
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'assertion-or-configuration';
    console.error(`Retention fixture verification failed (${code}). Check target, access, and assertions in this script.`);
    process.exitCode = 1;
});
