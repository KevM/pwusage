import { NextResponse } from 'next/server';
import { OAUTH_SCOPES } from '@/lib/oauth/types';
import { getAppBaseUrl } from '@/lib/url-utils';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'public, max-age=300',
};

export async function GET(request: Request): Promise<Response> {
    const origin = getAppBaseUrl(request);
    return NextResponse.json(
        {
            issuer: origin,
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/api/oauth/token`,
            registration_endpoint: `${origin}/api/oauth/register`,
            revocation_endpoint: `${origin}/api/oauth/revoke`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            scopes_supported: [...OAUTH_SCOPES],
            client_id_metadata_document_supported: true,
        },
        { status: 200, headers: CORS_HEADERS },
    );
}

export async function OPTIONS(): Promise<Response> {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}
