import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  signOutEverywhere: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock('@/lib/user-repo', () => ({
  UserRepo: class {
    signOutEverywhere = mocks.signOutEverywhere;
  },
}));

import { POST } from './route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://pwusage.test/api/auth/sign-out-everywhere', {
    method: 'POST',
    headers,
  });
}

describe('POST /api/auth/sign-out-everywhere', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.signOutEverywhere.mockResolvedValue({ disconnectedApps: 0 });
  });

  it('signs out every session, disconnects AI apps, and clears the caller cookie', async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.signOutEverywhere).toHaveBeenCalledWith('user-1');
    const cleared = response.cookies.get('site_auth');
    expect(cleared?.value).toBe('');
    expect(cleared?.maxAge).toBe(0);
  });

  it('returns 401 without bumping when unauthenticated', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
    expect(mocks.signOutEverywhere).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin request', async () => {
    const response = await POST(makeRequest({ origin: 'https://evil.example' }));

    expect(response.status).toBe(403);
    expect(mocks.signOutEverywhere).not.toHaveBeenCalled();
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects a cross-site fetch even without an origin header', async () => {
    const response = await POST(makeRequest({ 'sec-fetch-site': 'cross-site' }));

    expect(response.status).toBe(403);
    expect(mocks.signOutEverywhere).not.toHaveBeenCalled();
  });

  it('allows a same-origin request', async () => {
    const response = await POST(makeRequest({ origin: 'https://pwusage.test' }));

    expect(response.status).toBe(200);
    expect(mocks.signOutEverywhere).toHaveBeenCalledWith('user-1');
  });

  it('rejects an unparseable origin', async () => {
    const response = await POST(makeRequest({ origin: 'not a url' }));

    expect(response.status).toBe(403);
    expect(mocks.signOutEverywhere).not.toHaveBeenCalled();
  });
});
