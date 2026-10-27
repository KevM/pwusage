import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';

// Runs under scripts/test-compact-history.sh (private local PostgreSQL).
const socket = process.env.COMPACT_HISTORY_TEST_SOCKET;
const MIGRATION = 'db-migrations/20261027180000_user_auth_outage.sql';

describe.skipIf(!socket)('User auth outage timestamps', () => {
    let pool: Pool;
    let backfill: { id: string; auth_lost_at: Date | null }[];
    const read = async () => (await pool.query(
        `SELECT auth_lost_at, auth_restored_at FROM "User" WHERE id='u'`)).rows[0] as { auth_lost_at: Date | null; auth_restored_at: Date | null };
    const setStatus = (status: string) => pool.query(`UPDATE "User" SET auth_status=$1 WHERE id='u'`, [status]);

    beforeAll(async () => {
        const admin = new Pool({ host: socket, port: 55439, database: 'postgres', user: process.env.USER, max: 1 });
        await admin.query('DROP DATABASE IF EXISTS user_auth_outage');
        await admin.query('CREATE DATABASE user_auth_outage');
        await admin.end();
        pool = new Pool({ host: socket, port: 55439, database: 'user_auth_outage', user: process.env.USER, max: 2 });
        await pool.query(`DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;`);
        await pool.query(`CREATE TABLE "User" (id text PRIMARY KEY, auth_status varchar, is_active boolean, last_checked_at timestamp)`);
        await pool.query(`CREATE TABLE "Site" (id text PRIMARY KEY, user_id text)`);
        await pool.query(`CREATE TABLE "EnergyDayArchive" (site_id text, day_start timestamptz, status text)`);
        await pool.query(`INSERT INTO "User" (id, auth_status, last_checked_at) VALUES
            ('old-open', 'revoked', '2026-10-20 00:00'), ('old-checked', 'error', '2026-10-21 00:00'), ('fine', 'active', '2026-10-21 00:00')`);
        await pool.query(`INSERT INTO "Site" VALUES ('s1', 'old-open'), ('s2', 'old-checked')`);
        await pool.query(`INSERT INTO "EnergyDayArchive" VALUES ('s1', '2026-10-10 07:00Z', 'open'), ('s1', '2026-10-12 07:00Z', 'open'),
            ('s1', '2026-10-01 07:00Z', 'complete'), ('s2', '2026-10-01 07:00Z', 'complete')`);
        const sql = await readFile(MIGRATION, 'utf8');
        await pool.query(sql);
        backfill = (await pool.query(`SELECT id, auth_lost_at FROM "User" ORDER BY id`)).rows;
        await pool.query(sql); // idempotent
    });
    afterAll(async () => { await pool?.end(); });
    beforeEach(async () => {
        await pool.query('TRUNCATE "User"');
        await pool.query(`INSERT INTO "User" (id, auth_status, is_active) VALUES ('u', 'active', true)`);
    });

    it('backfills existing outages from the oldest open day, else the last check', () => {
        expect(backfill).toEqual([
            { id: 'fine', auth_lost_at: null },
            { id: 'old-checked', auth_lost_at: new Date('2026-10-21T00:00:00Z') },
            { id: 'old-open', auth_lost_at: new Date('2026-10-10T07:00:00Z') },
        ]);
    });

    it('a new active user has no outage', async () => {
        expect(await read()).toEqual({ auth_lost_at: null, auth_restored_at: null });
    });

    it('stamps auth_lost_at when access is lost and keeps the first loss time', async () => {
        await setStatus('error');
        const first = (await read()).auth_lost_at;
        expect(first).toBeInstanceOf(Date);
        await setStatus('revoked');
        await pool.query(`UPDATE "User" SET last_checked_at=now() WHERE id='u'`);
        expect((await read()).auth_lost_at).toEqual(first);
        expect((await read()).auth_restored_at).toBeNull();
    });

    it('stamps auth_restored_at on re-auth and keeps the outage window', async () => {
        await setStatus('revoked');
        const lost = (await read()).auth_lost_at!;
        await setStatus('active');
        const after = await read();
        expect(after.auth_lost_at).toEqual(lost);
        expect(after.auth_restored_at!.getTime()).toBeGreaterThanOrEqual(lost.getTime());
        const restored = after.auth_restored_at;
        await setStatus('active');
        expect((await read()).auth_restored_at).toEqual(restored);
    });

    it('a second outage after re-auth starts a new window', async () => {
        await pool.query(`UPDATE "User" SET auth_lost_at=now()-interval '2 days', auth_restored_at=now()-interval '1 day' WHERE id='u'`);
        await setStatus('no_token');
        const row = await read();
        expect(Date.now() - row.auth_lost_at!.getTime()).toBeLessThan(60_000);
        expect(row.auth_restored_at!.getTime()).toBeLessThan(row.auth_lost_at!.getTime());
    });

    it('no_sites is not an auth loss', async () => {
        await setStatus('no_sites');
        expect((await read()).auth_lost_at).toBeNull();
    });

    it('a user inserted without working auth starts lost', async () => {
        await pool.query(`INSERT INTO "User" (id, auth_status, is_active) VALUES ('v', 'revoked', false)`);
        const { rows: [row] } = await pool.query(`SELECT auth_lost_at FROM "User" WHERE id='v'`);
        expect(row.auth_lost_at).toBeInstanceOf(Date);
    });
});
