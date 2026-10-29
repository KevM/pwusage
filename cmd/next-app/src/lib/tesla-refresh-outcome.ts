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

export interface TeslaConnectionState {
    is_active?: boolean | null;
    auth_status?: string | null;
    tesla_refresh_state?: string;
    refresh_lock_expires?: number;
}

export function requiresTeslaReconnect(state: TeslaConnectionState): boolean {
    return state.auth_status === 'revoked' || state.tesla_refresh_state === 'uncertain'
        || state.tesla_refresh_state === 'reconnect_required'
        || (state.tesla_refresh_state === 'in_flight' && Number(state.refresh_lock_expires) <= Date.now());
}

export function assertTeslaConnection(state: TeslaConnectionState | null): void {
    if (!state || (state.is_active === false || state.is_active === null) || requiresTeslaReconnect(state)) throw new TeslaConnectionRequiredError();
    if (state.tesla_refresh_state === 'in_flight') throw new Error('Tesla connection is updating. Try again shortly.');
}

export function isTeslaConnectionRequired(error: unknown): boolean {
    return error instanceof TeslaConnectionRequiredError
        || (error instanceof TeslaRefreshError
            && (error.outcome === 'credential_rejected' || error.outcome === 'outcome_unknown'));
}
