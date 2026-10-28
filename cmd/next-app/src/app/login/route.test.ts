import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { loginAttemptCookieName, readLoginAttempt } from '@/lib/tesla-login-attempt';
const mocks = vi.hoisted(() => ({
    cookies: vi.fn(), redirect: vi.fn((path: string) => { throw Object.assign(new Error('Redirect'), { digest: `NEXT_REDIRECT;replace;${path};307;` }); }), cookieSet: vi.fn(), cookieDelete: vi.fn(),
    getAll: vi.fn((): { name: string; value: string }[] => []),
}));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
import { GET } from './route';
async function startLogin(request: NextRequest) {
    await expect(GET(request)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', 'tesla-client-id');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:5173');
    mocks.getAll.mockReturnValue([]);
    mocks.cookies.mockResolvedValue({ set: mocks.cookieSet, delete: mocks.cookieDelete, getAll: mocks.getAll });
});
afterEach(() => vi.unstubAllEnvs());
function issuedAttempt() {
    const authorize = new URL(mocks.redirect.mock.calls.at(-1)?.[0] as string);
    const state = authorize.searchParams.get('state') ?? '';
    const name = loginAttemptCookieName(state);
    const write = mocks.cookieSet.mock.calls.find(call => call[0] === name);
    if (!write) throw new Error('No attempt cookie');
    const attempt = readLoginAttempt(write[1] as string);
    if (!attempt) throw new Error('Invalid attempt cookie');
    return { authorize, state, attempt, options: write[2] as Record<string, unknown> };
}
describe('GET /login', () => {
    it('binds state, nonce, destination and mobile PKCE metadata to one expiring cookie', async () => {
        const challenge = 'A'.repeat(43);
        const mobileState = 'B'.repeat(32);
        await startLogin(new NextRequest(`http://localhost:5173/login?callback=/settings&mobile_challenge=${challenge}&mobile_state=${mobileState}`));
        const { authorize, state, attempt, options } = issuedAttempt();
        expect(state).toMatch(/^v2\.[a-f0-9]{32}$/);
        expect(attempt).toMatchObject({ callback: '/settings', mobileChallenge: challenge, mobileState });
        expect(attempt.mobileAttemptId).toMatch(/^[a-f0-9-]{36}$/);
        expect(authorize.searchParams.get('nonce')).toBe(attempt.nonce);
        expect(authorize.searchParams.get('client_id')).toBe('tesla-client-id');
        expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/tesla-callback');
        expect(authorize.searchParams.get('prompt_missing_scopes')).toBe('true');
        expect(authorize.searchParams.has('prompt')).toBe(false);
        expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 });
        expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
        expect(mocks.cookieDelete).not.toHaveBeenCalled();
    });
    it('never overwrites or clears another attempt', async () => {
        await startLogin(new NextRequest('http://localhost:5173/login'));
        const first = issuedAttempt();
        await startLogin(new NextRequest('http://localhost:5173/login'));
        const second = issuedAttempt();
        expect(first.state).not.toBe(second.state);
        expect(first.attempt.nonce).not.toBe(second.attempt.nonce);
        expect(mocks.cookieSet.mock.calls[0][0]).not.toBe(mocks.cookieSet.mock.calls[1][0]);
        expect(mocks.cookieDelete).not.toHaveBeenCalled();
    });
    it.each(['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/bad\npath', '/' + 'a'.repeat(1024)])(
        'does not store unsafe or oversized destination %s', async callback => {
            await startLogin(new NextRequest(`http://localhost:5173/login?callback=${encodeURIComponent(callback)}`));
            expect(issuedAttempt().attempt.callback).toBeUndefined();
        });
    it('rejects malformed mobile parameters without issuing cookies', async () => {
        const response = await GET(new NextRequest('http://localhost:5173/login?mobile_challenge=bad&mobile_state=bad'));
        expect(response.status).toBe(400);
        expect(mocks.cookieSet).not.toHaveBeenCalled();
    });
    it.each(['', '   '])('fails cleanly when the client id is missing or blank', async clientId => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', clientId);
        const response = await GET(new NextRequest('http://localhost:5173/login'));
        expect(response.status).toBe(500);
        expect(mocks.cookieSet).not.toHaveBeenCalled();
        expect(mocks.cookieDelete).not.toHaveBeenCalled();
    });
    it('returns a mobile configuration error to the fixed app callback', async () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', '');
        const response = await GET(new NextRequest(`http://localhost:5173/login?mobile_challenge=${'A'.repeat(43)}&mobile_state=${'B'.repeat(32)}`));
        const location = new URL(response.headers.get('location') ?? '');
        expect(location.protocol).toBe('pwusage:');
        expect(location.searchParams.get('error')).toBe('login_unavailable');
        expect(location.searchParams.get('state')).toBe('B'.repeat(32));
    });
    it.each(['next-router-prefetch', 'purpose', 'sec-purpose'])('ignores speculative %s requests', async header => {
        const response = await GET(new NextRequest('http://localhost:5173/login', { headers: { [header]: 'prefetch' } }));
        expect(response.status).toBe(204);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(mocks.cookies).not.toHaveBeenCalled();
        expect(mocks.redirect).not.toHaveBeenCalled();
    });
    it('canonicalizes production aliases before creating cookies and preserves parameters', async () => {
        vi.stubEnv('VERCEL_ENV', 'production');
        const response = await GET(new NextRequest('https://deployment.vercel.app/login?callback=%2Fproducts'));
        expect(response.headers.get('location')).toBe('https://pwusage.fm.rodeo/login?callback=%2Fproducts');
        expect(mocks.cookies).not.toHaveBeenCalled();
    });
    it('pins the production callback even with a misconfigured public URL', async () => {
        vi.stubEnv('VERCEL_ENV', 'production');
        vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://wrong.example');
        await startLogin(new NextRequest('https://pwusage.fm.rodeo/login'));
        expect(issuedAttempt().authorize.searchParams.get('redirect_uri')).toBe('https://pwusage.fm.rodeo/auth/tesla-callback');
        expect(issuedAttempt().options.secure).toBe(true);
    });
    it('bounds sequential pending attempts without deleting existing attempts', async () => {
        mocks.getAll.mockReturnValue(Array.from({ length: 8 }, (_, i) => ({
            name: `auth_attempt_${i.toString(16).padStart(32, '0')}`, value: 'existing',
        })));
        const response = await GET(new NextRequest('http://localhost:5173/login'));
        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('600');
        expect(mocks.cookieSet).not.toHaveBeenCalled();
        expect(mocks.cookieDelete).not.toHaveBeenCalled();
    });
});
