import { revokeOAuthToken } from '@/lib/oauth/oauth-repo';
import { readBoundedRequestText } from '@/lib/oauth/bounded-body';
import { logEvent, observeRoute } from '@/lib/observability';

const REVOKE_HEADERS = {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export const POST = observeRoute('/api/oauth/revoke', async (request: Request): Promise<Response> => {
    const rawBody = await readBoundedRequestText(request);
    if (rawBody === null) {
        return new Response(null, { status: 413, headers: REVOKE_HEADERS });
    }
    const form = new URLSearchParams(rawBody);
    const token = form.get('token')?.trim() ?? '';
    if (token) {
        await revokeOAuthToken(token);
    }
    logEvent('info', 'oauth.revoke', { hadToken: token.length > 0 });
    return new Response(null, { status: 200, headers: REVOKE_HEADERS });
});

export async function OPTIONS(): Promise<Response> {
    return new Response(null, { status: 204, headers: REVOKE_HEADERS });
}
