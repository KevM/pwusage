import { describe, expect, it } from 'vitest';
import {
    assertTeslaConnection, isTeslaConnectionRequired, requiresTeslaReconnect,
    TeslaConnectionRequiredError, TeslaRefreshBackoffError, TeslaRefreshError,
} from './tesla-refresh-outcome';

const ready = { is_active: true, auth_status: 'active', tesla_refresh_state: 'ready', refresh_lock_expires: 0, tesla_refresh_retry_after: 0 };

describe('assertTeslaConnection', () => {
    it('lets requests proceed while another worker refreshes', () => {
        expect(() => assertTeslaConnection({ ...ready, tesla_refresh_state: 'in_flight', refresh_lock_expires: Date.now() + 60_000 })).not.toThrow();
    });

    it('treats an expired lease as recoverable, not a reconnect', () => {
        const expired = { ...ready, tesla_refresh_state: 'in_flight', refresh_lock_expires: 1 };
        expect(requiresTeslaReconnect(expired)).toBe(false);
        expect(() => assertTeslaConnection(expired)).not.toThrow();
    });

    it('fails fast during a refresh backoff instead of sending a rejected token', () => {
        const retryAfter = Date.now() + 60_000;
        const error = (() => { try { assertTeslaConnection({ ...ready, tesla_refresh_retry_after: String(retryAfter) }); } catch (e) { return e; } })();
        expect(error).toBeInstanceOf(TeslaRefreshBackoffError);
        expect((error as TeslaRefreshBackoffError).retryAfter).toBe(retryAfter);
        expect(() => assertTeslaConnection({ ...ready, tesla_refresh_retry_after: Date.now() - 1 })).not.toThrow();
    });

    it.each(['uncertain', 'reconnect_required'])('requires a reconnect for %s', state => {
        expect(() => assertTeslaConnection({ ...ready, tesla_refresh_state: state })).toThrow(TeslaConnectionRequiredError);
    });
});

describe('isTeslaConnectionRequired', () => {
    it('only treats a rejected grant as needing a reconnect', () => {
        expect(isTeslaConnectionRequired(new TeslaRefreshError('credential_rejected'))).toBe(true);
        expect(isTeslaConnectionRequired(new TeslaRefreshError('outcome_unknown', 503))).toBe(false);
        expect(isTeslaConnectionRequired(new TeslaRefreshBackoffError(Date.now()))).toBe(false);
    });
});
