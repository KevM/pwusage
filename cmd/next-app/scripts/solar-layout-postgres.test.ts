import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const socket = process.env.SOLAR_TEST_SOCKET;
const safeSocket = socket && /^\/(?:private\/)?tmp\/solar-layout-pg-[a-zA-Z0-9]+$/.test(socket);
if (socket && !safeSocket) throw new Error('Expected a disposable local PostgreSQL socket');
const holder = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../src/lib/db', () => ({ pool: { query: (...args: Parameters<Pool['query']>) => holder.pool!.query(...args) } }));
import { SolarLayoutRepo } from '../src/lib/solar-layout-repo';

const locationSourceMigration = fileURLToPath(new URL('../db-migrations/20261030150000_site_solar_layout_location_source.sql', import.meta.url));
const DETECTED = JSON.stringify({ status: 'detected', confidence: 'high', planes: [] });

describe.skipIf(!safeSocket)('solar layout scheduling in disposable PostgreSQL', () => {
    beforeAll(async () => {
        holder.pool = new Pool({ host: socket, port: 55443, user: process.env.USER, database: 'postgres' });
        await holder.pool.query(`
            CREATE TABLE "User" (id text primary key, roles text[]);
            CREATE TABLE "Site" (id text primary key, user_id text, timezone text);
            CREATE TABLE "SiteSolarLayout" (site_id text primary key, latitude numeric, longitude numeric, location_set_at timestamptz, result jsonb, status text, detected_at timestamptz, attempted_at timestamptz, detector_version integer);
            INSERT INTO "User" VALUES ('beta', ARRAY['solar-forecast-beta']), ('other', ARRAY[]::text[]);
            INSERT INTO "Site" SELECT id, CASE WHEN id = 'other' THEN 'other' ELSE 'beta' END, 'UTC' FROM unnest(ARRAY['early','boundary','late','success','low','old','missing','other']) AS id;
            INSERT INTO "SiteSolarLayout" (site_id, latitude, longitude, status, detected_at, attempted_at)
            SELECT id, CASE WHEN id = 'missing' THEN NULL ELSE 1 END, 2,
              CASE WHEN id IN ('success','old') THEN 'detected' WHEN id = 'low' THEN 'low-confidence' ELSE 'not-enough-history' END,
              CASE WHEN id = 'old' THEN '2026-09-01'::timestamptz ELSE '2026-10-27'::timestamptz END,
              CASE WHEN id = 'early' THEN '2026-10-27 12:01Z'::timestamptz WHEN id = 'boundary' THEN '2026-10-27 12:00Z'::timestamptz ELSE '2026-10-27 11:00Z'::timestamptz END
            FROM unnest(ARRAY['early','boundary','late','success','low','old','missing','other']) AS id;
        `);
        // Applied after the rows exist, so the backfill is exercised on real legacy rows.
        await holder.pool.query(readFileSync(locationSourceMigration, 'utf8'));
    });
    afterAll(async () => { await holder.pool?.end(); });

    async function stored(siteId: string) {
        const { rows } = await holder.pool!.query(`
            SELECT status, detected_at, attempted_at, result, location_source, latitude::float8 AS latitude, longitude::float8 AS longitude, detector_version
            FROM "SiteSolarLayout" WHERE site_id = $1
        `, [siteId]);
        return rows[0];
    }

    async function seed(siteId: string, row: { lat: number | null; lon: number; source: string | null; status: string; result?: string | null; detectedAt?: string | null; attemptedAt?: string | null }) {
        await holder.pool!.query(`INSERT INTO "Site" VALUES ($1, 'beta', 'UTC')`, [siteId]);
        await holder.pool!.query(`
            INSERT INTO "SiteSolarLayout" (site_id, latitude, longitude, status, result, detected_at, attempted_at, location_source)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz, $8)
        `, [siteId, row.lat, row.lon, row.status, row.result ?? null, row.detectedAt ?? null, row.attemptedAt ?? null, row.source]);
    }

    it('applies both age gates and preserves throttling on a repeated location', async () => {
        const repo = new SolarLayoutRepo();
        const now = new Date('2026-10-28T12:00:00Z');
        expect((await repo.listDue(20, now)).map(row => row.siteId).sort()).toEqual(['boundary', 'late', 'old']);
        await repo.setLocation('early', 1, 2, 'estimated');
        expect((await repo.listDue(20, now)).map(row => row.siteId)).not.toContain('early');
    });

    it('the location-source migration backfills legacy locations as estimated and can run again', async () => {
        expect((await stored('early')).location_source).toBe('estimated');
        expect((await stored('missing')).location_source).toBeNull();
        await holder.pool!.query(readFileSync(locationSourceMigration, 'utf8'));
        expect((await stored('early')).location_source).toBe('estimated');
    });

    it('a phone location moving away from an estimate keeps the detected layout and queues re-detection', async () => {
        await seed('move', { lat: 43.39, lon: -87.87, source: 'estimated', status: 'detected', result: DETECTED, detectedAt: '2026-10-27T12:00Z', attemptedAt: '2026-10-27T12:00Z' });
        const repo = new SolarLayoutRepo();
        expect(await repo.setLocation('move', 43.2, -87.5, 'device')).toBe('stored');
        const row = await stored('move');
        expect(row).toMatchObject({ status: 'detected', location_source: 'device', latitude: 43.2, longitude: -87.5, detected_at: null, attempted_at: null });
        expect(row.result).toMatchObject({ confidence: 'high' });
        expect((await repo.listDue(20, new Date('2026-10-27T13:00Z'))).map(r => r.siteId)).toContain('move');
    });

    it('a legacy detected layout with no recorded source keeps its layout when a phone location arrives', async () => {
        await seed('legacy-move', { lat: 1, lon: 2, source: null, status: 'detected', result: DETECTED, detectedAt: '2026-10-27T12:00Z' });
        expect(await new SolarLayoutRepo().setLocation('legacy-move', 3, 4, 'device')).toBe('stored');
        expect(await stored('legacy-move')).toMatchObject({ status: 'detected', location_source: 'device', detected_at: null });
    });

    it('a detection for the old location cannot overwrite the re-queued row, but one for the new location can', async () => {
        const repo = new SolarLayoutRepo();
        await repo.saveResult('move', { status: 'detected', confidence: 'low', planes: [] } as never, 2, { latitude: 43.39, longitude: -87.87 });
        expect(await stored('move')).toMatchObject({ detected_at: null, detector_version: null });
        expect((await stored('move')).result).toMatchObject({ confidence: 'high' });
        await repo.saveResult('move', { status: 'detected', confidence: 'medium', planes: [] } as never, 2, { latitude: 43.2, longitude: -87.5 });
        expect(await stored('move')).toMatchObject({ detector_version: 2 });
        expect((await stored('move')).result).toMatchObject({ confidence: 'medium' });
    });

    it('a phone location moving between phone locations queues detection as before', async () => {
        await seed('phone-move', { lat: 1, lon: 2, source: 'device', status: 'detected', result: DETECTED, detectedAt: '2026-10-27T12:00Z', attemptedAt: '2026-10-27T12:00Z' });
        await new SolarLayoutRepo().setLocation('phone-move', 3, 4, 'device');
        expect(await stored('phone-move')).toMatchObject({ status: 'pending', detected_at: null, attempted_at: null });
    });

    it('an admin estimate cannot replace a phone location unless overwriteDevice is set', async () => {
        await seed('phone', { lat: 1, lon: 2, source: 'device', status: 'pending' });
        const repo = new SolarLayoutRepo();
        expect(await repo.setLocation('phone', 5, 6, 'estimated')).toBe('device-location-kept');
        expect(await stored('phone')).toMatchObject({ latitude: 1, longitude: 2, location_source: 'device' });
        expect(await repo.setLocation('phone', 5, 6, 'estimated', { overwriteDevice: true })).toBe('stored');
        expect(await stored('phone')).toMatchObject({ latitude: 5, longitude: 6, location_source: 'estimated', status: 'pending' });
    });

    it('the same location from the phone upgrades the source and keeps the schedule', async () => {
        await seed('same', { lat: 1, lon: 2, source: 'estimated', status: 'detected', result: DETECTED, detectedAt: '2026-10-27T12:00Z', attemptedAt: '2026-10-27T12:00Z' });
        await new SolarLayoutRepo().setLocation('same', 1, 2, 'device');
        expect(await stored('same')).toMatchObject({ status: 'detected', location_source: 'device', detected_at: expect.any(Date), attempted_at: expect.any(Date) });
    });
});
