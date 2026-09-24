import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db', () => ({ pool: { query: mocks.query } }));

import {
  createMobileLoginHandoff,
  consumeMobileLoginHandoff,
  createCodeChallenge,
  isValidMobileLoginParameters,
} from './mobile-login-handoff';

describe('mobile login handoff', () => {
  beforeEach(() => mocks.query.mockReset());

  it('accepts only valid PKCE challenge, attempt, and app state inputs', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(createCodeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(isValidMobileLoginParameters('a'.repeat(43), 'b'.repeat(32))).toBe(true);
    expect(isValidMobileLoginParameters('short', 'b'.repeat(32))).toBe(false);
  });

  it('stores only the handoff code hash and requests bounded cleanup', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const result = await createMobileLoginHandoff({
      attemptId: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
      codeChallenge: 'c'.repeat(43),
      appState: 'd'.repeat(32),
      userId: 'user-1',
      siteIds: ['site-1'],
      roles: ['user'],
    });

    expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0][0]).toContain('DELETE FROM "MobileLoginHandoff"');
    expect(mocks.query.mock.calls[1][0]).toContain('INSERT INTO "MobileLoginHandoff"');
    expect(mocks.query.mock.calls[1][1]).not.toContain(result.code);
    expect(mocks.query.mock.calls[1][1][1]).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.query.mock.calls[1][1][7]).toBe(5);
    expect(mocks.query.mock.calls[1][1]).toContain(result.attemptId);
  });

  it('consumes a matching unexpired attempt in one atomic update', async () => {
    mocks.query.mockResolvedValue({ rows: [{ user_id: 'user-1', site_ids: ['site-1'], roles: ['user'] }] });
    const result = await consumeMobileLoginHandoff({
      attemptId: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
      code: 'e'.repeat(43),
      verifier: 'f'.repeat(43),
      appState: 'd'.repeat(32),
    });

    expect(result).toEqual({ userId: 'user-1', siteIds: ['site-1'], roles: ['user'] });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0]).toContain('UPDATE "MobileLoginHandoff"');
    expect(mocks.query.mock.calls[0][0]).toContain('consumed_at IS NULL');
    expect(mocks.query.mock.calls[0][0]).toContain('expires_at > now()');
  });

  it('rejects replay, expired, and wrong verifier/state when no row is returned', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const result = await consumeMobileLoginHandoff({
      attemptId: '9b47b05a-3f0b-498e-b604-9e43fa7df015',
      code: 'e'.repeat(43),
      verifier: 'f'.repeat(43),
      appState: 'd'.repeat(32),
    });
    expect(result).toBeNull();
  });
});
