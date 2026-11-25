export const OAUTH_SCOPES = ['billing:read', 'usage:read'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const ACCESS_TOKEN_PREFIX = 'pwu_oat_';
export const REFRESH_TOKEN_PREFIX = 'pwu_ort_';
export const DCR_CLIENT_ID_PREFIX = 'pwu_client_';

export const AUTH_CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const GRANT_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface OAuthClientMetadata {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    clientUri: string | null;
    kind: 'dcr' | 'cimd';
}

export interface OAuthAccessContext {
    grantId: string;
    userId: string;
    clientId: string;
    clientName: string;
    scopes: OAuthScope[];
    authorizedSiteIds: string[];
}
