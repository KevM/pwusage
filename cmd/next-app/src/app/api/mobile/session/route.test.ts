import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  getById: vi.fn(),
  getSitesForUser: vi.fn(),
  signSiteToken: vi.fn(() => 'signed-site-token'),
}));
vi.mock('@/lib/mobile-login-handoff', () => ({
  consumeMobileLoginHandoff: mocks.consume,
  isValidMobileLoginExchangeParameters: (attemptId: string, code: string, verifier: string, state: string) =>
    attemptId.length > 0 && code.length === 43 && verifier.length >= 43 && state.length >= 22,
}));
vi.mock('@/lib/user-repo', () => ({ UserRepo: class { getById = mocks.getById; } }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSitesForUser = mocks.getSitesForUser; } }));
vi.mock('@/lib/auth-jwt', () => ({ signSiteToken: mocks.signSiteToken, COOKIE_MAX_AGE_SECONDS: 604800 }));

import { POST } from './route';

const payload = {
  attemptId: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
  code: 'a'.repeat(43),
  verifier: 'b'.repeat(43),
  state: 'c'.repeat(32),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/mobile/session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consume.mockResolvedValue({ userId: 'user-1', siteIds: ['site-1'], roles: ['user'] });
    mocks.getById.mockResolvedValue({ id: 'user-1', is_active: true, roles: ['user'] });
    mocks.getSitesForUser.mockResolvedValue([{ id: 'site-1' }]);
  });

  it('sets the existing site_auth cookie for URLSession with production protections', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('site_auth=signed-site-token');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.signSiteToken).toHaveBeenCalledWith(['site-1'], ['user'], 'user-1', undefined, 0);
  });

  it('marks the session cookie Secure for HTTPS even when NODE_ENV is not production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('rejects invalid payloads and handoff replay', async () => {
    const invalid = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST', body: JSON.stringify({ ...payload, verifier: 'bad' }), headers: { 'content-type': 'application/json' },
    }));
    expect(invalid.status).toBe(400);
    mocks.consume.mockResolvedValueOnce(null);
    const replay = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    }));
    expect(replay.status).toBe(401);
  });

  it('rejects a cross-origin text/plain form post before consuming a valid handoff', async () => {
    const response = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST',
      body: JSON.stringify({ ...payload, extra: 'ignored by JSON parser' }),
      headers: { 'content-type': 'text/plain', origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' },
    }));
    expect(response.status).toBe(415);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('rejects cross-origin JSON while allowing URLSession-style requests without Origin', async () => {
    const crossOrigin = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json; charset=utf-8', origin: 'https://attacker.test' },
    }));
    expect(crossOrigin.status).toBe(403);
    expect(mocks.consume).not.toHaveBeenCalled();

    const native = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST', body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }));
    expect(native.status).toBe(200);
    expect(mocks.consume).toHaveBeenCalledOnce();
  });

  it('rejects cross-site Fetch Metadata even when Origin is absent', async () => {
    const response = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST', body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    }));
    expect(response.status).toBe(403);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('fails closed if the user is inactive or the handoff sites are no longer assigned', async () => {
    mocks.getById.mockResolvedValueOnce({ id: 'user-1', is_active: false, roles: ['user'] });
    let response = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(401);

    mocks.getById.mockResolvedValueOnce({ id: 'user-1', is_active: true, roles: ['user'] });
    mocks.getSitesForUser.mockResolvedValueOnce([]);
    response = await POST(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(403);
    expect(mocks.signSiteToken).not.toHaveBeenCalled();
  });
});
