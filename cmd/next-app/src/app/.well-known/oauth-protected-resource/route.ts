import { NextResponse } from 'next/server';
import { OAUTH_SCOPES } from '@/lib/oauth/types';
import { expectedMcpResource } from '@/lib/oauth/validation';
import { getAppBaseUrl } from '@/lib/url-utils';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'public, max-age=300',
    // URLs come from the request's host when NEXT_PUBLIC_APP_URL is unset; never serve one host's metadata to another.
    Vary: 'Host',
};

export async function GET(request: Request): Promise<Response> {
    const origin = getAppBaseUrl(request);
    return NextResponse.json(
        {
            resource: expectedMcpResource(origin),
            authorization_servers: [origin],
            scopes_supported: [...OAUTH_SCOPES],
            bearer_methods_supported: ['header'],
        },
        { status: 200, headers: CORS_HEADERS },
    );
}

export async function OPTIONS(): Promise<Response> {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}
