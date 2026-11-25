import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { NextResponse } from 'next/server';
import { createPwusageMcpServer } from '@/lib/mcp/server';
import { authenticateOAuthAccessToken } from '@/lib/oauth/oauth-repo';
import { expectedMcpResource } from '@/lib/oauth/validation';
import { observeRoute } from '@/lib/observability';
import { getAppBaseUrl } from '@/lib/url-utils';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
    return NextResponse.json(
        { error: 'Method Not Allowed' },
        { status: 405, headers: { Allow: 'POST' } },
    );
}

export async function DELETE(): Promise<Response> {
    return NextResponse.json(
        { error: 'Method Not Allowed' },
        { status: 405, headers: { Allow: 'POST' } },
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
        return await transport.handleRequest(request);
    } finally {
        await server.close().catch(() => undefined);
    }
});
