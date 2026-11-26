export const OAUTH_SCOPES = ['billing:read', 'usage:read'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const ACCESS_TOKEN_PREFIX = 'pwu_oat_';
export const REFRESH_TOKEN_PREFIX = 'pwu_ort_';
export const DCR_CLIENT_ID_PREFIX = 'pwu_client_';
export const INTEGRATION_TOKEN_PREFIX = 'pwu_int_';

/**
 * Integration tokens are OAuth grants of kind 'token': a static bearer token
 * for scripts, bound to this resource so it never works on /api/mcp (and MCP
 * access tokens never work on the integration routes). Not a URL on purpose.
 */
export const INTEGRATION_RESOURCE = 'urn:pwusage:integrations:v1';
export const INTEGRATION_CLIENT_ID = 'pwu_integration';

/** 'app': an OAuth 2.1 client the user consented to. 'token': an integration token. */
export type GrantKind = 'app' | 'token';

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
