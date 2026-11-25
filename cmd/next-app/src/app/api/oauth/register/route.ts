import { NextResponse } from 'next/server';
import { registerDcrClient } from '@/lib/oauth/oauth-repo';
import { validateRedirectUri } from '@/lib/oauth/validation';
import { logEvent, observeRoute } from '@/lib/observability';

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const registrationRateMap = new Map<string, { count: number; resetAt: number }>();

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function checkRegistrationRateLimit(ip: string): boolean {
    const now = Date.now();
    const existing = registrationRateMap.get(ip);
    if (!existing || existing.resetAt <= now) {
        if (registrationRateMap.size >= 1000) {
            const first = registrationRateMap.keys().next().value;
            if (first !== undefined) registrationRateMap.delete(first);
        }
        registrationRateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }
    if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
        return false;
    }
    existing.count += 1;
    return true;
}

function clientIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
    }
    return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

function dcrError(error: string, description: string, status = 400): Response {
    return NextResponse.json(
        { error, error_description: description },
        { status, headers: CORS_HEADERS },
    );
}

export const POST = observeRoute('/api/oauth/register', async (request: Request): Promise<Response> => {
    const ip = clientIp(request);
    if (!checkRegistrationRateLimit(ip)) {
        return dcrError('invalid_client_metadata', 'Too many client registrations; try again later', 429);
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return dcrError('invalid_client_metadata', 'Request body must be valid JSON');
    }

    if (!body || typeof body !== 'object') {
        return dcrError('invalid_client_metadata', 'Request body must be a JSON object');
    }
    const payload = body as Record<string, unknown>;

    if (
        payload.token_endpoint_auth_method !== undefined
        && payload.token_endpoint_auth_method !== 'none'
    ) {
        return dcrError('invalid_client_metadata', 'Only public PKCE clients (token_endpoint_auth_method: "none") are supported');
    }

    if (typeof payload.client_name !== 'string') {
        return dcrError('invalid_client_metadata', 'client_name is required');
    }
    const clientName = payload.client_name.trim();
    if (clientName.length < 1 || clientName.length > 120) {
        return dcrError('invalid_client_metadata', 'client_name must be 1 to 120 characters');
    }

    if (!Array.isArray(payload.redirect_uris) || payload.redirect_uris.length === 0 || payload.redirect_uris.length > 20) {
        return dcrError('invalid_redirect_uri', 'redirect_uris must be a non-empty array of up to 20 URIs');
    }

    const redirectUris: string[] = [];
    for (const rawUri of payload.redirect_uris) {
        if (typeof rawUri !== 'string') {
            return dcrError('invalid_redirect_uri', 'Every redirect_uri must be a string');
        }
        const checked = validateRedirectUri(rawUri);
        if (!checked.ok) {
            return dcrError('invalid_redirect_uri', checked.error);
        }
        redirectUris.push(checked.uri);
    }

    let clientUri: string | null = null;
    if (payload.client_uri !== undefined && payload.client_uri !== null) {
        if (typeof payload.client_uri !== 'string') {
            return dcrError('invalid_client_metadata', 'client_uri must be a string');
        }
        const trimmedUri = payload.client_uri.trim();
        if (trimmedUri) {
            try {
                const parsed = new URL(trimmedUri);
                if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
                    return dcrError('invalid_client_metadata', 'client_uri must use http or https');
                }
                clientUri = parsed.href;
            } catch {
                return dcrError('invalid_client_metadata', 'client_uri is not a valid URL');
            }
        }
    }

    const client = await registerDcrClient({
        clientName,
        redirectUris,
        clientUri,
    });

    logEvent('info', 'oauth.register', {
        clientId: client.clientId,
        redirectUriCount: client.redirectUris.length,
    });

    return NextResponse.json(
        {
            client_id: client.clientId,
            client_name: client.clientName,
            redirect_uris: client.redirectUris,
            ...(client.clientUri ? { client_uri: client.clientUri } : {}),
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
        },
        { status: 201, headers: CORS_HEADERS },
    );
});

export async function OPTIONS(): Promise<Response> {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}
