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
