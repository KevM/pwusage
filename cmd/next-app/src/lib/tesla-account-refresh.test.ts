import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteRepo } from './site-repo';

const { query, exchange, logEvent } = vi.hoisted(() => ({
    query: vi.fn(), exchange: vi.fn(), logEvent: vi.fn(),
}));
vi.mock('./db', () => ({ pool: { query } }));
vi.mock('./tesla-auth', async importOriginal => ({
    ...await importOriginal<typeof import('./tesla-auth')>(), refreshAccessToken: exchange,
}));
vi.mock('./observability', () => ({ logEvent }));

import { TeslaTokenRepo } from './tesla-token-repo';
import { isTeslaAuthError, TeslaAuthError } from './tesla-client';
import { checkIoDeadline, withIoDeadline } from './io-deadline';

const original = { access_token: 'access-A', refresh_token: 'refresh-A' };
const rotated = { access_token: 'access-B', refresh_token: 'refresh-B' };

function setup() {
    const siteRepo = {
        getSite: vi.fn(async () => ({ user_id: 'owner' })),
        invalidateCache: vi.fn(),
    } as unknown as SiteRepo;
    return new TeslaTokenRepo(siteRepo);
}

describe('account refresh coordination', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        exchange.mockResolvedValue(rotated);
    });
    afterEach(() => vi.useRealTimers());

    it('reuses credentials rotated since the site client was constructed', async () => {
        query.mockResolvedValue({ rowCount: 1, rows: [{ ...rotated, auth_status: 'active', is_refreshing: 1 }] });
        const result = await setup().getLockedRefreshHandler('site').refreshHandler(original.refresh_token);
        expect(result).toEqual(rotated);
        expect(exchange).not.toHaveBeenCalled();
    });

    it.each([null, ''])('recovers with a stored refresh grant when access is %s', async access => {
        query.mockResolvedValueOnce({ rowCount: 1, rows: [{ access_token: access, refresh_token: 'refresh-A' }] });
        query.mockResolvedValue({ rowCount: 1, rows: [] });
        expect(await setup().getLockedRefreshHandler('site').refreshHandler('refresh-A')).toEqual(rotated);
        expect(exchange).toHaveBeenCalledWith('refresh-A');
    });

    it('uses the latest stored refresh grant if a stale caller finds no usable access credential', async () => {
        query.mockResolvedValueOnce({ rowCount: 1, rows: [{ access_token: null, refresh_token: 'refresh-current' }] });
        query.mockResolvedValue({ rowCount: 1, rows: [] });
        expect(await setup().getLockedRefreshHandler('site').refreshHandler('refresh-stale')).toEqual(rotated);
        expect(exchange).toHaveBeenCalledWith('refresh-current');
    });

    it('persists a user refresh before returning to the browser', async () => {
        query.mockResolvedValueOnce({ rowCount: 1, rows: [original] });
        query.mockResolvedValue({ rowCount: 1, rows: [] });
        const result = await setup().getLockedUserRefreshHandler('owner').refreshHandler(original.refresh_token);
        expect(result).toEqual(rotated);
        expect(exchange).toHaveBeenCalledWith(original.refresh_token);
        expect(query).toHaveBeenCalledWith(expect.stringMatching(/SET access_token = \$1, refresh_token = \$2/),
            expect.arrayContaining([rotated.access_token, rotated.refresh_token, 'owner', original.refresh_token]));
        expect(query.mock.calls.findIndex(([sql]) => sql.includes('SET access_token')))
            .toBeLessThan(query.mock.calls.findIndex(([sql]) => sql.includes('SET is_refreshing = 0')));
    });

    it('lets a waiting browser reuse the credentials saved by a site refresh', async () => {
        let finishExchange!: (value: typeof rotated) => void;
        exchange.mockImplementation(() => new Promise<typeof rotated>(resolve => { finishExchange = resolve; }));
        let held = false;
        let saved = original;
        query.mockImplementation(async (sql: string) => {
            if (sql.includes('SET is_refreshing = 1')) {
                if (held) return { rowCount: 0, rows: [] };
                held = true;
                return { rowCount: 1, rows: [saved] };
            }
            if (sql.includes('SET access_token')) saved = rotated;
            if (sql.includes('SET is_refreshing = 0')) held = false;
            return { rowCount: 1, rows: [{ ...saved, is_refreshing: Number(held), auth_status: 'active' }] };
        });
        vi.useFakeTimers();
        const repo = setup();
        const site = repo.getLockedRefreshHandler('site').refreshHandler(original.refresh_token);
        await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(1));
        const browser = repo.getLockedUserRefreshHandler('owner').refreshHandler(original.refresh_token);
        await vi.waitFor(() => expect(query.mock.calls.filter(([sql]) => sql.includes('SET is_refreshing = 1'))).toHaveLength(2));
        finishExchange(rotated);
        expect(await site).toEqual(rotated);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await browser).toEqual(rotated);
        expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('does not overwrite credentials replaced by a login during the Tesla exchange', async () => {
        const login = { access_token: 'login-access', refresh_token: 'login-refresh' };
        query.mockResolvedValueOnce({ rowCount: 1, rows: [original] });
        query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // guarded save lost to login
        query.mockResolvedValue({ rowCount: 1, rows: [{ ...login, is_refreshing: 0, auth_status: 'active' }] });
        expect(await setup().getLockedUserRefreshHandler('owner').refreshHandler(original.refresh_token)).toEqual(login);
        const save = query.mock.calls.find(([sql]) => sql.includes('SET access_token'));
        expect(save?.[0]).toMatch(/AND refresh_token = \$4/);
        expect(save?.[0]).toMatch(/AND refresh_lock_expires = \$5/);
    });

    it('does not revoke a newer login when the old exchange is rejected', async () => {
        exchange.mockRejectedValue(new TeslaAuthError('Rejected', 401));
        query.mockResolvedValueOnce({ rowCount: 1, rows: [original] });
        query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // guarded revoke lost to login
        query.mockResolvedValue({ rowCount: 1, rows: [{ ...rotated, is_refreshing: 0, auth_status: 'active' }] });
        const handlers = setup().getLockedUserRefreshHandler('owner');
        expect(await handlers.refreshHandler(original.refresh_token)).toEqual(rotated);
        const revoke = query.mock.calls.find(([sql]) => sql.includes("auth_status = 'revoked'"));
        expect(revoke?.[0]).toMatch(/AND refresh_token = \$2/);
        expect(revoke?.[0]).toMatch(/AND refresh_lock_expires = \$3/);
    });

    it('atomically marks a genuine rejection revoked and releases its lease', async () => {
        exchange.mockRejectedValue(new Error('Tesla API Error: 401 Unauthorized invalid_grant'));
        query.mockResolvedValueOnce({ rowCount: 1, rows: [original] });
        query.mockResolvedValue({ rowCount: 1, rows: [] });
        await expect(setup().getLockedUserRefreshHandler('owner').refreshHandler(original.refresh_token)).rejects.toThrow('401');
        expect(query).toHaveBeenCalledWith(expect.stringMatching(/SET is_refreshing = 0[\s\S]*auth_status = 'revoked'/),
            expect.arrayContaining(['owner', original.refresh_token]));
    });

    it('does not revoke an account on a transient failure', async () => {
        exchange.mockRejectedValue(new Error('Network timeout'));
        query.mockResolvedValueOnce({ rowCount: 1, rows: [original] });
        query.mockResolvedValue({ rowCount: 1, rows: [] });
        await expect(setup().getLockedUserRefreshHandler('owner').refreshHandler(original.refresh_token)).rejects.toThrow('timeout');
        expect(query.mock.calls.some(([sql]) => sql.includes("auth_status = 'revoked'"))).toBe(false);
    });

    it('does not let a waiter retry an expired access credential after the winning refresh failed transiently', async () => {
        query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        query.mockResolvedValue({ rows: [{ ...original, is_refreshing: 0, auth_status: 'active' }] });
        const result = await setup().getLockedUserRefreshHandler('owner').refreshHandler(original.refresh_token).catch(error => error);
        expect(result).toBeInstanceOf(Error);
        expect(isTeslaAuthError(result)).toBe(false);
        expect(exchange).not.toHaveBeenCalled();
    });

    it('saves a successful rotation even if the requesting job is cancelled immediately afterward', async () => {
        const parent = new AbortController();
        query.mockImplementation(async (sql: string) => {
            checkIoDeadline(); // The real pool wrapper rejects cancelled operations.
            return { rowCount: 1, rows: sql.includes('SET is_refreshing = 1') ? [original] : [] };
        });
        exchange.mockImplementation(async () => {
            parent.abort(new Error('Job cancelled'));
            return rotated;
        });
        let handler: Promise<unknown> = Promise.resolve();
        await withIoDeadline(10000, () => {
            handler = setup().getLockedUserRefreshHandler('owner').refreshHandler(original.refresh_token);
            return handler;
        }, parent.signal).catch(() => undefined);
        expect(await handler).toEqual(rotated);
    });

    it('never releases a replacement worker\'s lease', async () => {
        query.mockResolvedValueOnce({ rowCount: 1, rows: [original] });
        query.mockResolvedValue({ rowCount: 1, rows: [] });
        await setup().getLockedUserRefreshHandler('owner').refreshHandler(original.refresh_token);
        const release = query.mock.calls.find(([sql]) => sql.includes('SET is_refreshing = 0'));
        expect(release?.[0]).toMatch(/AND refresh_lock_expires = \$2/);
    });

    it('logs fingerprints without exporting credential values', async () => {
        query.mockResolvedValueOnce({ rowCount: 1, rows: [original] });
        query.mockResolvedValue({ rowCount: 1, rows: [] });
        await setup().getLockedUserRefreshHandler('owner').refreshHandler(original.refresh_token);
        const events = JSON.stringify(logEvent.mock.calls);
        expect(events).not.toContain(original.refresh_token);
        expect(events).not.toContain(rotated.refresh_token);
        expect(logEvent).toHaveBeenCalledWith('info', 'tesla.refresh.succeeded', expect.objectContaining({
            previousCredentialId: expect.stringMatching(/^[a-f0-9]{16}$/),
            credentialId: expect.stringMatching(/^[a-f0-9]{16}$/),
        }));
    });
});
