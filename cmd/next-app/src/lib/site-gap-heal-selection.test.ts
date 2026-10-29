import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db', () => ({ pool: { query } }));
import { SiteRepo } from './site-repo';

// Private local PostgreSQL only, via npm run test:compact.
const socket = process.env.COMPACT_HISTORY_TEST_SOCKET;
const now = Date.parse('2026-10-27T12:00:00Z');
const DAY = 86_400_000;

describe.skipIf(!socket)('gap-heal eligibility after auth recovery (PostgreSQL)', () => {
    let pool: Pool;
    beforeAll(async () => {
        const admin = new Pool({ host: socket, port: 55439, database: 'postgres', user: process.env.USER, max: 1 });
        try {
            await admin.query('CREATE DATABASE gap_heal_selection');
        } finally { await admin.end(); }
        pool = new Pool({ host: socket, port: 55439, database: 'gap_heal_selection', user: process.env.USER, max: 1 });
        await pool.query(`CREATE TABLE "User" (
            id text PRIMARY KEY, is_active boolean, refresh_token text, auth_status text,
            auth_lost_at timestamptz, auth_restored_at timestamptz,
            tesla_refresh_state text NOT NULL DEFAULT 'ready'
        ); CREATE TABLE "Site" (
            id text PRIMARY KEY, user_id text, timezone text DEFAULT 'America/Chicago',
            installed timestamptz DEFAULT '2025-01-01Z', last_live_refresh_at bigint, last_import_at bigint
        )`);
        const fixtures = [
            { id: 'active', live: now - DAY, imported: 2 },
            { id: 'idle-recovered', restored: now - 10 * DAY, lost: now - 30 * DAY, imported: 1 },
            { id: 'boundary', restored: now - 14 * DAY, lost: now - 30 * DAY, imported: 3 },
            { id: 'expired', restored: now - 14 * DAY - 1, lost: now - 30 * DAY },
            { id: 'idle' },
            { id: 'lost-again', restored: now - 2 * DAY, lost: now - DAY },
            { id: 'revoked', restored: now - DAY, lost: now - 2 * DAY, status: 'revoked' },
            { id: 'inactive', restored: now - DAY, lost: now - 2 * DAY, active: false },
            { id: 'no-token', restored: now - DAY, lost: now - 2 * DAY, token: false },
            { id: 'no-outage', restored: now - DAY },
            { id: 'reconnect', live: now - DAY, refreshState: 'reconnect_required' },
        ];
        for (const fixture of fixtures) {
            await pool.query(`INSERT INTO "User" VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
                fixture.id, fixture.active ?? true, fixture.token === false ? null : 'test-only', fixture.status ?? 'active',
                fixture.lost ? new Date(fixture.lost) : null, fixture.restored ? new Date(fixture.restored) : null,
                fixture.refreshState ?? 'ready',
            ]);
            await pool.query(`INSERT INTO "Site" (id,user_id,last_live_refresh_at,last_import_at) VALUES ($1,$1,$2,$3)`,
                [fixture.id, fixture.live ?? null, fixture.imported ?? null]);
        }
        query.mockImplementation((sql: string, params: unknown[]) => pool.query(sql, params));
    });
    afterAll(async () => { await pool?.end(); });

    it('includes idle recovered sites for the full recovery window while preserving auth guards and fair ordering', async () => {
        const sites = await new SiteRepo().getSitesForGapHeal(now - 7 * DAY, now - 14 * DAY);
        expect(sites.map(site => site.id)).toEqual(['idle-recovered', 'active', 'boundary']);
        expect(sites[0]).toMatchObject({
            auth_lost_at: new Date(now - 30 * DAY), auth_restored_at: new Date(now - 10 * DAY),
        });
    });
});
