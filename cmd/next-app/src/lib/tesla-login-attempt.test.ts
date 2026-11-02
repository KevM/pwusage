import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMobileAttemptState, loginAttemptCookieName, newLoginAttemptState, readLoginAttempt } from './tesla-login-attempt';
afterEach(() => vi.useRealTimers());
describe('login attempt state', () => {
    it('marks mobile attempts so a callback without the cookie can still return to the app', () => {
        const mobile = newLoginAttemptState(true);
        const web = newLoginAttemptState(false);
        expect(mobile).toMatch(/^v2\.m\.[a-f0-9]{32}$/);
        expect(web).toMatch(/^v2\.[a-f0-9]{32}$/);
        expect(isMobileAttemptState(mobile)).toBe(true);
        expect(isMobileAttemptState(web)).toBe(false);
        expect(loginAttemptCookieName(mobile)).toBe(`auth_attempt_${mobile.slice(5)}`);
        expect(loginAttemptCookieName(web)).toBe(`auth_attempt_${web.slice(3)}`);
    });
    it('only recognises the exact mobile marker', () => {
        for (const state of ['v2.m.', 'v2.m.' + 'a'.repeat(31), 'v2.mm.' + 'a'.repeat(32), 'm.' + 'a'.repeat(32), 'xyz']) {
            expect(isMobileAttemptState(state)).toBe(false);
        }
    });
});
describe('login attempt validation', () => {
    it('does not derive cookie names from arbitrary callback input', () => {
        for (const state of ['xyz', 'v2.', 'v2.' + 'a'.repeat(33), 'v2.auth_state', '../auth_state']) {
            expect(loginAttemptCookieName(state)).toBeUndefined();
        }
    });
    it('rejects expired, malformed and excessively long-lived attempts', () => {
        vi.useFakeTimers();
        const valid = { nonce: 'a'.repeat(32), loginId: '9b47b05a-3f0b-498e-b604-9e43fa7df015', expiresAt: Date.now() + 600_000 };
        expect(readLoginAttempt(JSON.stringify(valid))).toEqual(valid);
        for (const value of ['bad', 'null', JSON.stringify({ ...valid, nonce: 123 }),
            JSON.stringify({ ...valid, mobileState: {} }), JSON.stringify({ ...valid, expiresAt: Date.now() + 601_000 })]) {
            expect(readLoginAttempt(value)).toBeUndefined();
        }
        vi.advanceTimersByTime(600_001);
        expect(readLoginAttempt(JSON.stringify(valid))).toBeUndefined();
    });
});
