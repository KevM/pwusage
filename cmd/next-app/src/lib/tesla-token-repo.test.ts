import { TeslaRefreshError, TeslaConnectionRequiredError, TeslaRefreshBackoffError } from './tesla-refresh-outcome';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptToken, encryptToken, isEncryptedToken, tokenFingerprint } from './token-crypto';

const { queryMock, refreshAccessTokenMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    refreshAccessTokenMock: vi.fn(),
}));

vi.mock('./db', () => ({
    pool: { query: queryMock }
}));

vi.mock('./tesla-auth', async importOriginal => ({
    ...await importOriginal<typeof import('./tesla-auth')>(),
    refreshAccessToken: refreshAccessTokenMock,
}));

import { TeslaTokenRepo } from './tesla-token-repo';
import { isTeslaAuthError } from './tesla-client';

describe('TeslaTokenRepo refresh wait', () => {
    let tokenRepo: TeslaTokenRepo;

    beforeEach(() => {
        queryMock.mockReset();
        refreshAccessTokenMock.mockReset();
        tokenRepo = new TeslaTokenRepo();
    });

    // The claim matches nothing, so the caller polls the account row.
    function unclaimed(row: Record<string, unknown> | undefined) {
        queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        queryMock.mockResolvedValueOnce({ rows: row ? [row] : [] });
        return tokenRepo.getLockedUserRefreshHandler('user-1').refreshHandler('old-refresh');
    }

    it('throws when a concurrent refresh failed and left auth_status revoked', async () => {
        const error = await unclaimed({ access_token: 'old-token', refresh_token: 'old-refresh', is_refreshing: 0, auth_status: 'revoked' })
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(TeslaConnectionRequiredError);
        expect(isTeslaAuthError(error)).toBe(false);
    });

    it('adopts a concurrent rotation read back encrypted', async () => {
        const tokens = await unclaimed({
            access_token: encryptToken('rotated-access', 'access_token', 'user-1'),
            refresh_token: encryptToken('rotated-refresh', 'refresh_token', 'user-1'),
            is_refreshing: 0, auth_status: 'active', tesla_refresh_state: 'ready',
        });
        expect(tokens).toEqual({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
    });

    it('does not mistake the caller\'s own encrypted grant for a rotation', async () => {
        // Same grant, different ciphertext/IV: must compare decrypted values.
        queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        queryMock.mockResolvedValue({ rows: [{
            access_token: encryptToken('a', 'access_token', 'user-1'),
            refresh_token: encryptToken('old-refresh', 'refresh_token', 'user-1'),
            is_refreshing: 0, auth_status: 'active', tesla_refresh_state: 'ready', tesla_refresh_retry_after: String(Date.now() + 60_000),
        }] });
        await expect(tokenRepo.getLockedUserRefreshHandler('user-1').refreshHandler('old-refresh'))
            .rejects.toBeInstanceOf(TeslaRefreshBackoffError);
    });

    it('returns new tokens when a concurrent refresh succeeded', async () => {
        const tokens = await unclaimed({ access_token: 'new-token', refresh_token: 'new-refresh', is_refreshing: 0, auth_status: 'active', tesla_refresh_state: 'ready' });
        expect(tokens).toEqual({ access_token: 'new-token', refresh_token: 'new-refresh' });
        expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    });

    it('fails fast with a backoff while the stored grant is cooling down', async () => {
        const retryAfter = Date.now() + 60_000;
        const error = await unclaimed({ access_token: 'old-token', refresh_token: 'old-refresh', is_refreshing: 0, auth_status: 'error', tesla_refresh_state: 'ready', tesla_refresh_retry_after: String(retryAfter) })
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(TeslaRefreshBackoffError);
        expect((error as TeslaRefreshBackoffError).retryAfter).toBe(retryAfter);
        expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    });

    it('throws a clean error when the user row no longer exists', async () => {
        await expect(unclaimed(undefined)).rejects.toThrow('Token refresh wait failed: user not found');
    });
});

describe('getLockedUserRefreshHandler', () => {
    let tokenRepo: TeslaTokenRepo;

    beforeEach(() => {
        queryMock.mockReset();
        refreshAccessTokenMock.mockReset();
        tokenRepo = new TeslaTokenRepo();
    });

    it('atomically revokes and releases lock on terminal failure so waiters cannot observe the unlocked-without-revoked state', async () => {
        // acquireRefreshLock UPDATE → lock acquired
        queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ access_token: 'old-token', refresh_token: 'old-refresh' }] });
        // atomic revoke+release UPDATE
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        queryMock.mockResolvedValue({ rowCount: 0, rows: [] });

        refreshAccessTokenMock.mockRejectedValueOnce(new TeslaRefreshError('credential_rejected'));

        const handlers = tokenRepo.getLockedUserRefreshHandler('user-1');
        await expect(handlers.refreshHandler('old-refresh')).rejects.toThrow();

        // Find the query that releases the lock (sets is_refreshing = 0 in SET clause, not WHERE).
        // The acquire query has is_refreshing = 1 in SET, so exclude any call containing that.
        const lockReleaseCall = queryMock.mock.calls.find(
            (call) =>
                typeof call[0] === 'string' &&
                (call[0] as string).includes('is_refreshing = 0') &&
                !(call[0] as string).includes('SET is_refreshing = 1'),
        );
        expect(lockReleaseCall, 'expected a query that releases the lock').toBeDefined();
        expect(lockReleaseCall![1]).toContain('reconnect_required');
        expect(lockReleaseCall![0]).not.toContain('is_active = false');
    });

    it('does not re-submit a refresh token after a concurrent refresh revoked the user', async () => {
        // A request that got its 401 before a concurrent refresh revoked the user
        // arrives after that refresh released the lock. It must not take the free
        // lock and send the same dead refresh token to Tesla again.
        const user = { is_refreshing: 0, auth_status: 'revoked' };
        queryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SET is_refreshing = 1')) {
                const excludesRevoked = /auth_status IS DISTINCT FROM 'revoked'/.test(sql);
                return { rowCount: user.is_refreshing === 0 && !(excludesRevoked && user.auth_status === 'revoked') ? 1 : 0 };
            }
            if (sql.includes('SELECT access_token')) {
                return { rows: [{ access_token: 'old-token', refresh_token: 'old-refresh', ...user }] };
            }
            return { rowCount: 1 };
        });

        const handlers = tokenRepo.getLockedUserRefreshHandler('user-1');
        await expect(handlers.refreshHandler('old-refresh')).rejects.toThrow('Reconnect Tesla');
        expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    });

    it('releases lock normally on non-terminal (transient) failure', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ access_token: 'old-token', refresh_token: 'old-refresh' }] }); // claim snapshot
        queryMock.mockResolvedValueOnce({ rowCount: 1 }); // releaseRefreshLock UPDATE

        refreshAccessTokenMock.mockRejectedValueOnce(new Error('Network timeout'));

        const handlers = tokenRepo.getLockedUserRefreshHandler('user-1');
        await expect(handlers.refreshHandler('old-refresh')).rejects.toThrow();

        const lockReleaseCall = queryMock.mock.calls.find(
            (call) =>
                typeof call[0] === 'string' &&
                (call[0] as string).includes('is_refreshing = 0') &&
                !(call[0] as string).includes('is_refreshing = 1'),
        );
        expect(lockReleaseCall, 'expected a normal lock-release query').toBeDefined();
        // Connection health may record the outage, but account eligibility must not change.
        expect(lockReleaseCall![0]).not.toMatch(/is_active\s*=/);
    });
});

describe('TeslaTokenRepo refresh persistence', () => {
    let tokenRepo: TeslaTokenRepo;

    beforeEach(() => {
        queryMock.mockReset();
        tokenRepo = new TeslaTokenRepo();
    });

    it('refresh persists new tokens with credential and lease guards', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ access_token: 'old-token', refresh_token: 'old-refresh' }] });
        queryMock.mockResolvedValue({ rowCount: 1, rows: [] });

        refreshAccessTokenMock.mockResolvedValueOnce({ access_token: 'new-access', refresh_token: 'new-refresh' });

        const handlers = tokenRepo.getLockedUserRefreshHandler('user-1');
        await handlers.refreshHandler('old-refresh');

        // Guarded by credential generation and attempt, not the lease clock:
        // Tesla already consumed the old grant, so a slow save must still land.
        const save = queryMock.mock.calls.find(([sql]) => String(sql).includes('SET access_token = $1'));
        // The CAS compares the HMAC fingerprint (random-IV ciphertext never
        // matches); the plaintext arm covers rows not yet backfilled.
        expect(save?.[0]).toContain('refresh_token_fp = $7');
        expect(save?.[0]).toContain('(refresh_token_fp = $4 OR (refresh_token_fp IS NULL AND refresh_token = $8))');
        expect(save?.[0]).toContain('tesla_credential_generation = $5');
        expect(save?.[0]).toContain('tesla_refresh_attempt_id = $6');
        expect(save?.[0]).toContain('is_refreshing = 0, refresh_lock_expires = 0');
        expect(save?.[0]).not.toContain('refresh_lock_expires >');
        const params = save?.[1] as string[];
        expect(isEncryptedToken(params[0])).toBe(true);
        expect(isEncryptedToken(params[1])).toBe(true);
        expect(decryptToken(params[0], 'access_token', 'user-1')).toBe('new-access');
        expect(decryptToken(params[1], 'refresh_token', 'user-1')).toBe('new-refresh');
        expect(params[2]).toBe('user-1');
        expect(params[3]).toBe(tokenFingerprint('old-refresh'));
        expect(params.slice(4, 6)).toEqual([undefined, expect.any(String)]);
        expect(params[6]).toBe(tokenFingerprint('new-refresh'));
        expect(params[7]).toBe('old-refresh');
    });

    it('claims the grant by fingerprint, not by ciphertext', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ access_token: encryptToken('old-token', 'access_token', 'user-1'), refresh_token: encryptToken('old-refresh', 'refresh_token', 'user-1') }] });
        queryMock.mockResolvedValue({ rowCount: 1, rows: [] });
        refreshAccessTokenMock.mockResolvedValueOnce({ access_token: 'new-access', refresh_token: 'new-refresh' });

        await tokenRepo.getLockedUserRefreshHandler('user-1').refreshHandler('old-refresh');

        const claim = queryMock.mock.calls.find(([sql]) => String(sql).includes('SET is_refreshing = 1'));
        expect(claim?.[0]).toContain('(refresh_token_fp = $5 OR (refresh_token_fp IS NULL AND refresh_token = $6))');
        expect(claim?.[1].slice(4)).toEqual([tokenFingerprint('old-refresh'), 'old-refresh']);
        // The grant sent to Tesla is the decrypted one from the claimed row.
        expect(refreshAccessTokenMock).toHaveBeenCalledWith('old-refresh', expect.anything());
    });

});
