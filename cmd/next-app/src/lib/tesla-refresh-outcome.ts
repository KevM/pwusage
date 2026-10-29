/** Outcomes concern the refresh grant, never app session eligibility. */
export type RefreshExchangeOutcome = 'not_dispatched' | 'credentials_received'
    | 'credential_rejected' | 'configuration_rejected' | 'outcome_unknown';
export type RefreshFailureOutcome = Exclude<RefreshExchangeOutcome, 'credentials_received'>;
export type TeslaOAuthErrorCode = 'invalid_grant' | 'login_required' | 'invalid_client'
    | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_request';

export class TeslaRefreshError extends Error {
    constructor(
        public readonly outcome: RefreshFailureOutcome,
        public readonly status: number | null = null,
        public readonly errorCode: TeslaOAuthErrorCode | null = null,
        message = `Tesla refresh exchange: ${outcome}`,
    ) {
        super(message);
        this.name = 'TeslaRefreshError';
    }
}

export class TeslaConnectionRequiredError extends Error {
    readonly code = 'TESLA_CONNECTION_REQUIRED';
    constructor() {
        super('Reconnect Tesla to update your data.');
        this.name = 'TeslaConnectionRequiredError';
    }
}

// Long enough for a slow worker to finish its 18s exchange and save before the
// grant can be claimed again; short enough that a 429/5xx blip is not an outage.
export const TRANSIENT_BACKOFF_MS = 2 * 60_000;

/** A refresh failed transiently; the stored grant is retried after `retryAfter`. */
export class TeslaRefreshBackoffError extends Error {
    readonly code = 'TESLA_REFRESH_BACKOFF';
    constructor(public readonly retryAfter: number) {
        super('Tesla is temporarily unavailable. Try again in a few minutes.');
        this.name = 'TeslaRefreshBackoffError';
    }
}

export interface TeslaConnectionState {
    is_active?: boolean | null;
    auth_status?: string | null;
    tesla_refresh_state?: string;
    refresh_lock_expires?: number;
    tesla_refresh_retry_after?: number | string | null;
}

/**
 * Only Tesla rejecting the grant needs a reconnect. An unresolved exchange
 * (lost response, expired lease) is retried with the same grant after a
 * backoff: if Tesla consumed it, the replacement was never stored, so a retry
 * cannot lose anything we hold (see DesignDecisions.md).
 */
export function requiresTeslaReconnect(state: TeslaConnectionState): boolean {
    return state.auth_status === 'revoked' || state.tesla_refresh_state === 'uncertain'
        || state.tesla_refresh_state === 'reconnect_required';
}

/**
 * A refresh another worker is still running. Background paths wait it out; an
 * expired lease is not active, so they reach the refresh path that recovers it.
 */
export function isRefreshLeaseActive(state: TeslaConnectionState): boolean {
    return state.tesla_refresh_state === 'in_flight' && Number(state.refresh_lock_expires) > Date.now();
}

/**
 * Gate before each Fleet request. An in-flight refresh is not an error: the
 * request either succeeds with the current access token or its 401 waits on the
 * refresh. A cooling-down refresh fails fast instead of sending a token Tesla
 * already rejected.
 */
export function assertTeslaConnection(state: TeslaConnectionState | null): void {
    if (!state || (state.is_active === false || state.is_active === null) || requiresTeslaReconnect(state)) throw new TeslaConnectionRequiredError();
    const retryAfter = Number(state.tesla_refresh_retry_after ?? 0);
    if (state.tesla_refresh_state === 'ready' && retryAfter > Date.now()) throw new TeslaRefreshBackoffError(retryAfter);
}

export function isTeslaConnectionRequired(error: unknown): boolean {
    return error instanceof TeslaConnectionRequiredError
        || (error instanceof TeslaRefreshError && error.outcome === 'credential_rejected');
}
