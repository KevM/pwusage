import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  cookie: '',
  active: true,
  sessionVersion: 0,
  siteIds: ['site-1'],
  consume: vi.fn(),
  getById: vi.fn(),
  getSitesForUser: vi.fn(),
  deleteCookie: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === 'site_auth' && state.cookie ? { value: state.cookie } : undefined,
    delete: (cookie: string | { name: string }) => {
      const name = typeof cookie === 'string' ? cookie : cookie.name;
      state.deleteCookie(cookie);
      if (name === 'site_auth') state.cookie = '';
    },
  })),
}));
vi.mock('next/navigation', () => ({ redirect: state.redirect }));
vi.mock('@/lib/mobile-login-handoff', () => ({
  consumeMobileLoginHandoff: state.consume,
  isValidMobileLoginExchangeParameters: () => true,
}));
vi.mock('@/lib/user-repo', () => ({
  UserRepo: class {
    getById = state.getById;
    isActive = async () => state.active;
    getAuthState = async () => ({
      isActive: state.active,
      sessionVersion: state.sessionVersion ?? 0,
      roles: ['user'],
    });
  },
  isUserActive: async () => state.active,
}));
vi.mock('@/lib/site-repo', () => ({
  SiteRepo: class {
    getSitesForUser = state.getSitesForUser;
  },
}));

import { POST as exchangeSession } from './route';
import { verifySiteAccess } from '@/lib/auth-checks';
import { verifySiteToken } from '@/lib/auth-jwt';
import { proxy } from '../../../../proxy';
import { POST as logout } from '../../../logout/route';

const exchangePayload = {
  attemptId: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
  code: 'a'.repeat(43),
  verifier: 'b'.repeat(43),
  state: 'c'.repeat(32),
};

describe('mobile session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cookie = '';
    state.active = true;
    state.sessionVersion = 0;
    state.siteIds = ['site-1'];
    state.consume.mockResolvedValue({ userId: 'user-1', siteIds: ['site-1'], roles: ['user'] });
    state.getById.mockImplementation(async () => ({
      id: 'user-1',
      is_active: true,
      roles: ['user'],
      session_version: state.sessionVersion,
    }));
    state.getSitesForUser.mockImplementation(async () => state.siteIds.map(id => ({ id })));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects exchange cookie to site authorization, renewal, and logout', async () => {
    const exchangeResponse = await exchangeSession(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST',
      body: JSON.stringify(exchangePayload),
      headers: { 'content-type': 'application/json' },
    }));
    expect(exchangeResponse.status).toBe(200);

    const issuedCookie = exchangeResponse.cookies.get('site_auth')?.value;
    expect(issuedCookie).toBeTruthy();
    state.cookie = issuedCookie || '';

    expect(await verifySiteAccess('site-1')).toBe(true);
    expect(await verifySiteAccess('site-2')).toBe(false);

    state.siteIds = ['site-new'];
    vi.setSystemTime(new Date('2026-01-07T00:05:00.000Z'));
    const renewedResponse = await proxy(new NextRequest('https://pwusage.test/api/site-live-data', {
      headers: { cookie: `site_auth=${state.cookie}` },
    }));
    const renewedCookie = renewedResponse.cookies.get('site_auth')?.value;
    expect(renewedCookie).toBeTruthy();
    expect(renewedCookie).not.toBe(issuedCookie);
    expect(verifySiteToken(renewedCookie || '')?.sites).toEqual(['site-new']);

    state.cookie = renewedCookie || '';
    state.active = false;
    expect(await verifySiteAccess('site-new')).toBe(false);

    await logout();
    expect(state.deleteCookie).toHaveBeenCalledWith({ name: 'site_auth', path: '/' });
  });

  // Sign-out-everywhere end-to-end: after the DB session_version bumps, the
  // old cookie is blocked on every request AND the proxy refuses to renew it
  // (renewing would re-stamp the new sv and un-revoke a stolen session).
  it('blocks and refuses to renew a session revoked by a session_version bump', async () => {
    const exchangeResponse = await exchangeSession(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST',
      body: JSON.stringify(exchangePayload),
      headers: { 'content-type': 'application/json' },
    }));
    expect(exchangeResponse.status).toBe(200);

    const issuedCookie = exchangeResponse.cookies.get('site_auth')?.value;
    expect(issuedCookie).toBeTruthy();
    state.cookie = issuedCookie || '';

    expect(await verifySiteAccess('site-1')).toBe(true);

    // Another device called sign-out-everywhere: DB version bumped to 1.
    state.sessionVersion = 1;

    expect(await verifySiteAccess('site-1')).toBe(false);

    // The proxy must not renew the revoked cookie: no set-cookie at all.
    vi.setSystemTime(new Date('2026-01-07T00:05:00.000Z'));
    const renewedResponse = await proxy(new NextRequest('https://pwusage.test/api/site-live-data', {
      headers: { cookie: `site_auth=${state.cookie}` },
    }));
    expect(renewedResponse.cookies.get('site_auth')).toBeUndefined();

    // Re-authenticating issues a token stamped with the new DB version.
    const freshResponse = await exchangeSession(new NextRequest('https://pwusage.test/api/mobile/session', {
      method: 'POST',
      body: JSON.stringify(exchangePayload),
      headers: { 'content-type': 'application/json' },
    }));
    const freshCookie = freshResponse.cookies.get('site_auth')?.value;
    expect(freshCookie).toBeTruthy();
    state.cookie = freshCookie || '';

    expect(verifySiteToken(state.cookie)?.sv).toBe(1);
    expect(await verifySiteAccess('site-1')).toBe(true);
  });
});
