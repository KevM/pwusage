import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  verifySiteAccess: vi.fn(),
  userCanAccessSite: vi.fn(),
  getHoldForSite: vi.fn(),
  register: vi.fn(),
  syncDesired: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({
  getCurrentUser: mocks.getCurrentUser,
  verifySiteAccess: mocks.verifySiteAccess,
}));

vi.mock('@/lib/battery-hold-activity-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/battery-hold-activity-repo')>();
  return {
    ...actual,
    BatteryHoldActivityRepo: class {
      userCanAccessSite = mocks.userCanAccessSite;
      getHoldForSite = mocks.getHoldForSite;
      register = mocks.register;
      syncDesired = mocks.syncDesired;
      remove = mocks.remove;
    },
  };
});

import { DELETE, POST } from './route';

const URL_BASE = 'http://localhost/api/site/site-1/battery-hold/activities';
const ctx = { params: Promise.resolve({ id: 'site-1' }) } as never;
const SESSION_USER = { id: 'user-1' };
const ACTIVE_HOLD = { id: 7, status: 'active', restored_at: null };

function postReq(body: unknown, contentType: string | null = 'application/json') {
  const headers: Record<string, string> = contentType ? { 'content-type': contentType } : {};
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new NextRequest(URL_BASE, { method: 'POST', headers, body: payload });
}

function deleteReq(query = '') {
  return new NextRequest(`${URL_BASE}${query}`, { method: 'DELETE' });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    holdId: 7,
    registrationId: randomUUID(),
    pushToken: 'AB'.repeat(32),
    apnsEnvironment: 'sandbox',
    ...overrides,
  };
}

function expectRegistrationUntouched() {
  expect(mocks.userCanAccessSite).not.toHaveBeenCalled();
  expect(mocks.getHoldForSite).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.syncDesired).not.toHaveBeenCalled();
}

describe('battery-hold activities route', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getCurrentUser.mockResolvedValue(SESSION_USER);
    mocks.verifySiteAccess.mockResolvedValue(true);
    mocks.userCanAccessSite.mockResolvedValue(true);
    mocks.getHoldForSite.mockResolvedValue(ACTIVE_HOLD);
    mocks.register.mockResolvedValue('pending');
    mocks.syncDesired.mockResolvedValue(1);
    mocks.remove.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('POST', () => {
    it('returns 401 without a session user and does not touch the repo', async () => {
      mocks.getCurrentUser.mockResolvedValue(null);
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(mocks.verifySiteAccess).not.toHaveBeenCalled();
      expectRegistrationUntouched();
    });

    it('returns 403 when the session has no access to the site and does not touch the repo', async () => {
      mocks.verifySiteAccess.mockResolvedValue(false);
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expectRegistrationUntouched();
    });

    it('returns 415 for a non-JSON content type', async () => {
      const res = await POST(postReq(validBody(), 'text/plain'), ctx);
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'Content-Type must be application/json' });
      expectRegistrationUntouched();
    });

    it('returns 400 invalid_registration for malformed JSON', async () => {
      const res = await POST(postReq('{not json'), ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_registration' });
      expectRegistrationUntouched();
    });

    it.each([
      ['missing holdId', { holdId: undefined }],
      ['holdId as a string', { holdId: '7' }],
      ['fractional holdId', { holdId: 1.5 }],
      ['zero holdId', { holdId: 0 }],
      ['malformed registrationId', { registrationId: 'not-a-uuid' }],
      ['short pushToken', { pushToken: 'ab'.repeat(31) }],
      ['odd-length pushToken', { pushToken: 'ab'.repeat(32) + 'a' }],
      ['non-hex pushToken', { pushToken: 'zz'.repeat(32) }],
      ['unknown apnsEnvironment', { apnsEnvironment: 'staging' }],
    ])('returns 400 invalid_registration for %s and does not touch the repo', async (_label, overrides) => {
      const res = await POST(postReq(validBody(overrides)), ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_registration' });
      expectRegistrationUntouched();
    });

    it.each([
      ['preview', 'preview'],
      ['unset', undefined],
    ])('returns 400 apns_environment_not_allowed for production APNs on %s', async (_label, vercelEnv) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv); // undefined deletes the variable
      const res = await POST(postReq(validBody({ apnsEnvironment: 'production' })), ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'apns_environment_not_allowed' });
      expectRegistrationUntouched();
    });

    it('accepts production APNs on the production deployment', async () => {
      vi.stubEnv('VERCEL_ENV', 'production');
      const res = await POST(postReq(validBody({ apnsEnvironment: 'production' })), ctx);
      expect(res.status).toBe(200);
      expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ apnsEnvironment: 'production' }));
    });

    it('returns 403 when current DB access is revoked even though the session claim is valid', async () => {
      mocks.userCanAccessSite.mockResolvedValue(false);
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(mocks.userCanAccessSite).toHaveBeenCalledWith('user-1', 'site-1');
      expect(mocks.register).not.toHaveBeenCalled();
    });

    it('returns 404 hold_not_found when the hold does not belong to the site', async () => {
      mocks.getHoldForSite.mockResolvedValue(null);
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'hold_not_found' });
      expect(mocks.getHoldForSite).toHaveBeenCalledWith(7, 'site-1');
      expect(mocks.register).not.toHaveBeenCalled();
    });

    it('returns 410 hold_ended for a hold restored more than the window ago', async () => {
      mocks.getHoldForSite.mockResolvedValue({
        id: 7, status: 'restored', restored_at: new Date(Date.now() - 5 * 60 * 60 * 1000),
      });
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: 'hold_ended' });
      expect(mocks.register).not.toHaveBeenCalled();
    });

    it('accepts a registration for a hold that ended inside the window and seeds its terminal snapshot', async () => {
      mocks.getHoldForSite.mockResolvedValue({
        id: 7, status: 'restored', restored_at: new Date(Date.now() - 10 * 60 * 1000),
      });
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'registered', holdStatus: 'restored' });
      expect(mocks.syncDesired).toHaveBeenCalledWith(7);
    });

    it('returns 409 registration_conflict and skips the snapshot sync when register returns null', async () => {
      mocks.register.mockResolvedValue(null);
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'registration_conflict' });
      expect(mocks.syncDesired).not.toHaveBeenCalled();
    });

    it('returns 410 registration_disabled and skips the snapshot sync when the registration is disabled', async () => {
      mocks.register.mockResolvedValue('disabled');
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: 'registration_disabled' });
      expect(mocks.syncDesired).not.toHaveBeenCalled();
    });

    it('registers a normalised token and syncs the snapshot strictly after register', async () => {
      const registrationId = randomUUID();
      const res = await POST(postReq(validBody({
        registrationId: registrationId.toUpperCase(),
        pushToken: 'AB'.repeat(32),
      })), ctx);
      expect(res.status).toBe(200);
      expect(mocks.register).toHaveBeenCalledWith({
        holdId: 7,
        userId: 'user-1',
        registrationId,
        pushToken: 'ab'.repeat(32),
        apnsEnvironment: 'sandbox',
      });
      expect(mocks.syncDesired).toHaveBeenCalledWith(7);
      expect(mocks.syncDesired.mock.invocationCallOrder[0])
        .toBeGreaterThan(mocks.register.mock.invocationCallOrder[0]);
    });

    it('returns the registered status without echoing the push token', async () => {
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toContain('no-store');
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ status: 'registered', holdStatus: 'active' });
      expect(text).not.toContain('ab'.repeat(32));
      expect(text).not.toContain('AB'.repeat(32));
    });

    it('logs only the SQLSTATE, never the message, detail or token, when registration fails', async () => {
      const token = 'ab'.repeat(32);
      mocks.register.mockRejectedValue(Object.assign(new Error(`bad ${token}`), { code: '23514', detail: `Failing row contains (${token})` }));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith('[battery-hold-activities] registration failed', '23514');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(token);
    });

    it('returns 500 registration_failed without logging the token when the sync fails', async () => {
      mocks.syncDesired.mockRejectedValue(new Error('db down'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await POST(postReq(validBody()), ctx);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'registration_failed' });
      expect(errorSpy).toHaveBeenCalledWith('[battery-hold-activities] registration failed', 'Error');
      for (const call of errorSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('ab'.repeat(32));
      }
    });
  });

  describe('DELETE', () => {
    it('returns 401 without a session user', async () => {
      mocks.getCurrentUser.mockResolvedValue(null);
      const res = await DELETE(deleteReq(`?registrationId=${randomUUID()}`), ctx);
      expect(res.status).toBe(401);
      expect(mocks.remove).not.toHaveBeenCalled();
    });

    it.each([
      ['missing registrationId', ''],
      ['malformed registrationId', '?registrationId=not-a-uuid'],
    ])('returns 400 invalid_registration for a %s', async (_label, query) => {
      const res = await DELETE(deleteReq(query), ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_registration' });
      expect(mocks.remove).not.toHaveBeenCalled();
    });

    it.each([true, false])('removes the registration idempotently (row existed: %s)', async (existed) => {
      mocks.remove.mockResolvedValue(existed);
      const registrationId = randomUUID();
      const res = await DELETE(deleteReq(`?registrationId=${registrationId}`), ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'removed' });
      expect(mocks.remove).toHaveBeenCalledWith('user-1', 'site-1', registrationId);
      expect(mocks.verifySiteAccess).not.toHaveBeenCalled();
    });

    it('returns 500 removal_failed when the repo throws', async () => {
      mocks.remove.mockRejectedValue(new Error('db down'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await DELETE(deleteReq(`?registrationId=${randomUUID()}`), ctx);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'removal_failed' });
      expect(errorSpy).toHaveBeenCalledWith('[battery-hold-activities] removal failed', 'Error');
    });

    it('logs only the SQLSTATE, never the message, detail or token, when removal fails', async () => {
      const token = 'ab'.repeat(32);
      mocks.remove.mockRejectedValue(Object.assign(new Error(`bad ${token}`), { code: '40P01', detail: token }));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await DELETE(deleteReq(`?registrationId=${randomUUID()}`), ctx);
      expect(res.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith('[battery-hold-activities] removal failed', '40P01');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(token);
    });
  });
});
