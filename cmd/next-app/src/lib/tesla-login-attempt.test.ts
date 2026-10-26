import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginAttemptCookieName, readLoginAttempt } from './tesla-login-attempt';
afterEach(() => vi.useRealTimers());
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
