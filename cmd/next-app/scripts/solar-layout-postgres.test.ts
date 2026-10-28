import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const socket = process.env.SOLAR_TEST_SOCKET;
const safeSocket = socket && /^\/(?:private\/)?tmp\/solar-layout-pg-[a-zA-Z0-9]+$/.test(socket);
if (socket && !safeSocket) throw new Error('Expected a disposable local PostgreSQL socket');
const holder = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../src/lib/db', () => ({ pool: { query: (...args: Parameters<Pool['query']>) => holder.pool!.query(...args) } }));
import { SolarLayoutRepo } from '../src/lib/solar-layout-repo';

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
    });
    afterAll(async () => { await holder.pool?.end(); });
    it('applies both age gates and preserves throttling on a repeated location', async () => {
        const repo = new SolarLayoutRepo();
        const now = new Date('2026-10-28T12:00:00Z');
        expect((await repo.listDue(20, now)).map(row => row.siteId).sort()).toEqual(['boundary', 'late', 'old']);
        await repo.setLocation('early', 1, 2);
        expect((await repo.listDue(20, now)).map(row => row.siteId)).not.toContain('early');
    });
});
