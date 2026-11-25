import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { NextResponse } from 'next/server';
import { createPwusageMcpServer } from '@/lib/mcp/server';
import { authenticateOAuthAccessToken } from '@/lib/oauth/oauth-repo';
import { expectedMcpResource } from '@/lib/oauth/validation';
import { observeRoute } from '@/lib/observability';
import { getAppBaseUrl } from '@/lib/url-utils';

export const dynamic = 'force-dynamic';

/**
 * Browser MCP clients on other origins must preflight, call, and read the 401
 * challenge. Any origin is safe here: access is a bearer token in the
 * Authorization header, never a cookie, so credentials are not allowed.
 */
const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Max-Age': '86400',
};

function withCors(response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function OPTIONS(): Promise<Response> {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(): Promise<Response> {
    return NextResponse.json(
        { error: 'Method Not Allowed' },
        { status: 405, headers: { Allow: 'POST, OPTIONS', ...CORS_HEADERS } },
    );
}

export async function DELETE(): Promise<Response> {
    return NextResponse.json(
        { error: 'Method Not Allowed' },
        { status: 405, headers: { Allow: 'POST, OPTIONS', ...CORS_HEADERS } },
    );
}

export const POST = observeRoute('/api/mcp', async (request: Request): Promise<Response> => {
    const origin = getAppBaseUrl(request);
    const resource = expectedMcpResource(origin);
    const ctx = await authenticateOAuthAccessToken(
        request.headers.get('authorization'),
        resource,
    );

    if (!ctx) {
        return NextResponse.json(
            { error: 'unauthorized', error_description: 'Valid OAuth 2.1 Bearer token required' },
            {
                status: 401,
                headers: {
                    'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
                    'Cache-Control': 'no-store',
                    ...CORS_HEADERS,
                },
            },
        );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    const server = createPwusageMcpServer(ctx);
    try {
        await server.connect(transport);
        return withCors(await transport.handleRequest(request));
    } finally {
        await server.close().catch(() => undefined);
    }
});
