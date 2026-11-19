import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db', async importOriginal => ({ ...await importOriginal<typeof import('./db')>(), pool: { query } }));
const syncLogin = vi.hoisted(() => vi.fn());
vi.mock('./site-membership-service', () => ({ SiteMembershipService: class { syncLogin = syncLogin; } }));

import { TeslaAuthService, type TeslaCallbackParams } from './tesla-auth-service';
import { UserRepo } from './user-repo';
import type { SiteRepo } from './site-repo';
import type { TeslaClient } from './tesla-client';
import { decryptToken, encryptToken, tokenFingerprint } from './token-crypto';

// Run with npm run test:compact -- src/lib/tesla-auth-identity-postgres.test.ts.
// The runner creates a private local cluster; no .env or production DB is used.
describe.skipIf(!process.env.COMPACT_HISTORY_TEST_SOCKET)('Tesla login identity against PostgreSQL', () => {
    // One client, not a pool: pg-pool destroys a connection after a query error
    // (the unique violation under test), which would drop the temp tables.
    let pool: Client;
    const params: TeslaCallbackParams = {
        code: 'code', state: 'state', savedState: 'state', savedNonce: 'nonce', callbackUrl: 'http://localhost/cb',
    };
    const siteRepo = { assignSiteToUser: vi.fn(), removeSitesMissingFromTesla: vi.fn() };
    const importer = { ensureSite: vi.fn() };
    const teslaClient = {
        resolveRegion: vi.fn(),
        getBaseUrl: vi.fn(() => 'https://fleet-api.prd.na.vn.cloud.tesla.com'),
        getUserInfo: vi.fn(async () => ({ email: 'Shared@Example.com' })),
        getProducts: vi.fn(async () => [{ energy_site_id: 98765, resource_type: 'battery' }]),
    };

    const login = (repo: UserRepo, sub: string) => new TeslaAuthService({
        userRepo: repo,
        siteRepo: siteRepo as unknown as SiteRepo,
        teslaClientCreator: () => teslaClient as unknown as TeslaClient,
        importerCreator: () => importer,
        tokenExchange: async () => ({
            id_token: 'id', access_token: `access-${sub}`, refresh_token: `refresh-${sub}`, expires_in: 3600,
        }),
        verifyIdToken: async () => ({ nonce: 'nonce', sub, email: 'shared@example.com' }),
    }).handleTeslaCallback(params);

    const storedRows = async () => (await pool.query(
        'SELECT id, email, roles, session_version, access_token, refresh_token FROM "User" ORDER BY id',
    )).rows as Array<{ id: string; email: string; roles: string[]; access_token: string; refresh_token: string }>;

    beforeAll(async () => {
        pool = new Client({ host: process.env.COMPACT_HISTORY_TEST_SOCKET, port: 55439,
            database: 'postgres', user: process.env.USER });
        await pool.connect();
        // Mirrors the production "User" columns upsertOnTeslaAuth writes and the
        // case-insensitive email index from 20260703140233.
        await pool.query(`CREATE TEMP TABLE "User" (
            id text PRIMARY KEY, email text, access_token text, refresh_token text, refresh_token_fp text,
            token_expires_at bigint, auth_status text DEFAULT 'active', is_active boolean DEFAULT true,
            fleet_api_base_url text, roles text[] NOT NULL DEFAULT '{}'::text[],
            session_version integer NOT NULL DEFAULT 0, tesla_credential_generation integer NOT NULL DEFAULT 0,
            tesla_refresh_state text DEFAULT 'ready', tesla_refresh_attempt_id text,
            tesla_refresh_retry_after bigint DEFAULT 0, is_refreshing integer DEFAULT 0,
            refresh_lock_expires bigint DEFAULT 0, created_at timestamptz DEFAULT now()
        )`);
        await pool.query('CREATE UNIQUE INDEX idx_user_email_lower ON "User" (LOWER(email)) WHERE email IS NOT NULL');
        // The real subject-binding migration, twice to prove it is idempotent.
        const bindingMigration = readFileSync('db-migrations/20261118193518_user_tesla_subject_binding.sql', 'utf8');
        await pool.query(bindingMigration);
        await pool.query(bindingMigration);
        await pool.query('CREATE TEMP TABLE "SiteMember" (site_id text, user_id text, role text, PRIMARY KEY (site_id, user_id))');
        query.mockImplementation((sql: string, values?: unknown[]) => pool.query(sql, values));
    });
    afterAll(async () => { await pool?.end(); });
    beforeEach(async () => {
        vi.clearAllMocks();
        await pool.query('TRUNCATE "User"');
        await pool.query('TRUNCATE "SiteMember"');
        await pool.query(
            `INSERT INTO "User" (id, tesla_subject, email, roles, access_token, refresh_token, refresh_token_fp)
             VALUES ('admin-sub', 'admin-sub', 'shared@example.com', ARRAY['admin'], $1, $2, $3)`,
            [encryptToken('admin-access', 'access_token', 'admin-sub'),
                encryptToken('admin-refresh', 'refresh_token', 'admin-sub'), tokenFingerprint('admin-refresh')],
        );
        await pool.query(`INSERT INTO "SiteMember" (site_id, user_id, role) VALUES ('98765', 'admin-sub', 'owner')`);
    });

    const expectAdminIntact = async () => {
        const rows = await storedRows();
        expect(rows.map(row => row.id)).toEqual(['admin-sub']);
        const [admin] = rows;
        expect(admin.roles).toEqual(['admin']);
        expect(decryptToken(admin.access_token, 'access_token', 'admin-sub')).toBe('admin-access');
        expect(decryptToken(admin.refresh_token, 'refresh_token', 'admin-sub')).toBe('admin-refresh');
        expect((await pool.query('SELECT site_id, user_id, role FROM "SiteMember"')).rows)
            .toEqual([{ site_id: '98765', user_id: 'admin-sub', role: 'owner' }]);
        expect(siteRepo.assignSiteToUser).not.toHaveBeenCalled();
        expect(importer.ensureSite).not.toHaveBeenCalled();
        expect(syncLogin).not.toHaveBeenCalled();
    };

    it('rejects another subject found by the ordinary email lookup', async () => {
        expect(await login(new UserRepo(), 'other-sub')).toEqual({ status: 'identity-conflict' });
        await expectAdminIntact();
    });

    it('rejects another subject when the email unique index fires on the upsert', async () => {
        const repo = new UserRepo();
        // The pre-upsert lookup misses (the race window); the real index then
        // rejects the insert and the retry lookup finds the admin row.
        vi.spyOn(repo, 'getByEmail').mockResolvedValueOnce(null);
        expect(await login(repo, 'other-sub')).toEqual({ status: 'identity-conflict' });
        await expectAdminIntact();
    });

    it('still migrates a legacy email-keyed account to a verified login', async () => {
        await pool.query('TRUNCATE "User"');
        await pool.query(`INSERT INTO "User" (id, email) VALUES ('shared@example.com', 'shared@example.com')`);
        const result = await login(new UserRepo(), 'new-sub');
        expect(result).toMatchObject({ status: 'success', userId: 'shared@example.com' });
        const [row] = await storedRows();
        expect(decryptToken(row.refresh_token, 'refresh_token', row.id)).toBe('refresh-new-sub');
    });

    describe('after subject A migrates a legacy email-keyed account', () => {
        const legacyId = 'shared@example.com';
        beforeEach(async () => {
            await pool.query('TRUNCATE "User"');
            await pool.query('TRUNCATE "SiteMember"');
            await pool.query(`INSERT INTO "User" (id, email, roles) VALUES ($1, $1, ARRAY['admin'])`, [legacyId]);
            await pool.query(`INSERT INTO "SiteMember" (site_id, user_id, role) VALUES ('98765', $1, 'owner')`, [legacyId]);
            expect(await login(new UserRepo(), 'sub-a')).toMatchObject({ status: 'success', userId: legacyId });
            vi.clearAllMocks();
        });

        const expectAIntact = async () => {
            const rows = (await pool.query('SELECT id, tesla_subject, roles, access_token, refresh_token FROM "User"')).rows;
            expect(rows.map(row => [row.id, row.tesla_subject])).toEqual([[legacyId, 'sub-a']]);
            expect(rows[0].roles).toEqual(['admin']);
            expect(decryptToken(rows[0].access_token, 'access_token', legacyId)).toBe('access-sub-a');
            expect(decryptToken(rows[0].refresh_token, 'refresh_token', legacyId)).toBe('refresh-sub-a');
            expect((await pool.query('SELECT site_id, user_id, role FROM "SiteMember"')).rows)
                .toEqual([{ site_id: '98765', user_id: legacyId, role: 'owner' }]);
            expect(siteRepo.assignSiteToUser).not.toHaveBeenCalled();
            expect(syncLogin).not.toHaveBeenCalled();
        };

        it('records A as the account subject', async () => {
            await expectAIntact();
        });

        it('rejects subject B presenting the same email', async () => {
            expect(await login(new UserRepo(), 'sub-b')).toEqual({ status: 'identity-conflict' });
            await expectAIntact();
        });

        it('rejects subject B when the email unique index fires on the upsert', async () => {
            const repo = new UserRepo();
            vi.spyOn(repo, 'getByEmail').mockResolvedValueOnce(null);
            expect(await login(repo, 'sub-b')).toEqual({ status: 'identity-conflict' });
            await expectAIntact();
        });

        it('still lets A sign in again', async () => {
            expect(await login(new UserRepo(), 'sub-a')).toMatchObject({ status: 'success', userId: legacyId });
        });
    });
});
