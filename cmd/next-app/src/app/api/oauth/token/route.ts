import { NextResponse } from 'next/server';
import { exchangeAuthCode, rotateRefreshToken } from '@/lib/oauth/oauth-repo';
import { resolveMcpResource } from '@/lib/oauth/validation';
import { readBoundedRequestText } from '@/lib/oauth/bounded-body';
import { logEvent, observeRoute } from '@/lib/observability';
import { getAppBaseUrl } from '@/lib/url-utils';

const TOKEN_HEADERS = {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function tokenError(error: string, description: string, status = 400): Response {
    return NextResponse.json(
        { error, error_description: description },
        { status, headers: TOKEN_HEADERS },
    );
}

export const POST = observeRoute('/api/oauth/token', async (request: Request): Promise<Response> => {
    const rawBody = await readBoundedRequestText(request);
    if (rawBody === null) {
        return tokenError('invalid_request', 'Request body is too large', 413);
    }
    const form = new URLSearchParams(rawBody);
    const grantType = form.get('grant_type');
    const clientId = form.get('client_id')?.trim() ?? '';
    const origin = getAppBaseUrl(request);
    // Canonical form: what the code and grant store, so the comparisons below are exact.
    const resource = resolveMcpResource(form.get('resource'), origin);

    if (!clientId) {
        return tokenError('invalid_request', 'client_id is required');
    }
    if (!resource) {
        return tokenError('invalid_target', 'resource must match the canonical MCP endpoint');
    }

    if (grantType === 'authorization_code') {
        const code = form.get('code')?.trim() ?? '';
        const redirectUri = form.get('redirect_uri')?.trim() ?? '';
        const codeVerifier = form.get('code_verifier')?.trim() ?? '';
        if (!code || !redirectUri || !codeVerifier) {
            return tokenError('invalid_request', 'code, redirect_uri, and code_verifier are required');
        }

        const result = await exchangeAuthCode({
            code,
            clientId,
            redirectUri,
            codeVerifier,
            resource,
        });
        if (!result.ok) {
            logEvent('warn', 'oauth.token', { grantType, clientId, outcome: result.error });
            return tokenError(result.error, result.errorDescription);
        }

        logEvent('info', 'oauth.token', {
            grantType,
            grantId: result.grantId,
            clientId: result.clientId,
            outcome: 'issued',
        });
        return NextResponse.json(
            {
                access_token: result.accessToken,
                refresh_token: result.refreshToken,
                token_type: 'Bearer',
                expires_in: result.expiresIn,
                scope: result.scope,
            },
            { status: 200, headers: TOKEN_HEADERS },
        );
    }

    if (grantType === 'refresh_token') {
        const refreshToken = form.get('refresh_token')?.trim() ?? '';
        if (!refreshToken) {
            return tokenError('invalid_request', 'refresh_token is required');
        }

        const result = await rotateRefreshToken({
            refreshToken,
            clientId,
            resource,
        });
        if (!result.ok) {
            logEvent('warn', 'oauth.token', { grantType, clientId, outcome: result.error });
            return tokenError(result.error, result.errorDescription);
        }

        logEvent('info', 'oauth.token', {
            grantType,
            grantId: result.grantId,
            clientId: result.clientId,
            outcome: 'rotated',
        });
        return NextResponse.json(
            {
                access_token: result.accessToken,
                refresh_token: result.refreshToken,
                token_type: 'Bearer',
                expires_in: result.expiresIn,
                scope: result.scope,
            },
            { status: 200, headers: TOKEN_HEADERS },
        );
    }

    return tokenError('unsupported_grant_type', 'Supported grant_type values: authorization_code, refresh_token');
});

export async function OPTIONS(): Promise<Response> {
    return new Response(null, { status: 204, headers: TOKEN_HEADERS });
}
