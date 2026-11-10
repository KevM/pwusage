import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), deleteAccount: vi.fn() }));

vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/account-deletion-service', () => ({ deleteAccount: mocks.deleteAccount }));

import { DELETE } from './route';

function makeRequest(body: unknown = { confirm: 'DELETE' }, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest('https://pwusage.test/api/user', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

describe('DELETE /api/user', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
        mocks.deleteAccount.mockResolvedValue({ status: 'deleted', sitesDeleted: 1, sitesRetained: 0 });
    });

    it('deletes the account and clears the session cookie', async () => {
        const response = await DELETE(makeRequest());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(mocks.deleteAccount).toHaveBeenCalledWith('user-1', []);
        const cookie = response.cookies.get('site_auth');
        expect(cookie?.value).toBe('');
        expect(cookie?.maxAge).toBe(0);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it.each([
        [{ origin: 'https://evil.test' }],
        [{ origin: 'not a url' }],
        [{ 'sec-fetch-site': 'cross-site' }],
    ])('rejects cross-origin requests: %j', async headers => {
        const response = await DELETE(makeRequest({ confirm: 'DELETE' }, headers));
        expect(response.status).toBe(403);
        expect(mocks.deleteAccount).not.toHaveBeenCalled();
    });

    it('accepts a same-origin request', async () => {
        const response = await DELETE(makeRequest({ confirm: 'DELETE' }, {
            origin: 'https://pwusage.test',
            'sec-fetch-site': 'same-origin',
        }));
        expect(response.status).toBe(200);
    });

    it('passes the shared sites chosen for deletion through', async () => {
        await DELETE(makeRequest({ confirm: 'DELETE', deleteSiteIds: ['s2'] }));
        expect(mocks.deleteAccount).toHaveBeenCalledWith('user-1', ['s2']);
    });

    it.each([[{ confirm: 'DELETE', deleteSiteIds: 's2' }], [{ confirm: 'DELETE', deleteSiteIds: [1] }]])('rejects a malformed site list: %j', async body => {
        expect((await DELETE(makeRequest(body))).status).toBe(400);
        expect(mocks.deleteAccount).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated requests', async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        const response = await DELETE(makeRequest());
        expect(response.status).toBe(401);
        expect(mocks.deleteAccount).not.toHaveBeenCalled();
    });

    it.each([[{ confirm: 'delete' }], [{}], [null], ['not json']])('rejects bad confirmation: %j', async body => {
        const response = await DELETE(makeRequest(body));
        expect(response.status).toBe(400);
        expect(mocks.deleteAccount).not.toHaveBeenCalled();
    });

    it.each([
        ['needs_reconnect', 'TESLA_CONNECTION_REQUIRED'],
        ['battery_saver_pending', 'BATTERY_SAVER_PENDING'],
    ])('keeps the session when the result is %s', async (status, code) => {
        mocks.deleteAccount.mockResolvedValue({ status });
        const response = await DELETE(makeRequest());
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe(code);
        expect(response.cookies.get('site_auth')).toBeUndefined();
    });

    it('keeps the session and returns 500 when deletion throws', async () => {
        mocks.deleteAccount.mockRejectedValue(new Error('connection lost'));
        const response = await DELETE(makeRequest());
        expect(response.status).toBe(500);
        expect(response.cookies.get('site_auth')).toBeUndefined();
        expect(JSON.stringify(await response.json())).not.toContain('connection lost');
    });
});
