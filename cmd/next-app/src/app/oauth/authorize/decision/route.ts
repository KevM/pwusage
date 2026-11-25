import { NextResponse } from 'next/server';
import { getAuthorizedSiteIds, getCurrentUser } from '@/lib/auth-checks';
import { resolveOAuthClient } from '@/lib/oauth/client-resolver';
import { isSameOriginPost, verifyOAuthCsrfToken } from '@/lib/oauth/csrf';
import { createAuthCode } from '@/lib/oauth/oauth-repo';
import {
    isValidCodeChallenge,
    isValidMcpResource,
    parseRequestedScopes,
    validateRedirectUri,
} from '@/lib/oauth/validation';
import { logEvent, observeRoute } from '@/lib/observability';
import { refreshTodayData } from '@/lib/today-refresh';
import { getAppBaseUrl } from '@/lib/url-utils';

function buildRedirectLocation(baseUri: string, params: Record<string, string | null>): string {
    const url = new URL(baseUri);
    for (const [key, value] of Object.entries(params)) {
        if (value !== null && value !== '') {
            url.searchParams.set(key, value);
        }
    }
    return url.href;
}

export const POST = observeRoute('/oauth/authorize/decision', async (request: Request): Promise<Response> => {
    if (!isSameOriginPost(request)) {
        return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
    }

    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const form = new URLSearchParams(await request.text());
    const csrfToken = form.get('csrf_token') ?? '';
    if (!(await verifyOAuthCsrfToken(csrfToken, user.id))) {
        return NextResponse.json({ error: 'Invalid or expired CSRF token' }, { status: 403 });
    }

    const clientId = form.get('client_id')?.trim() ?? '';
    const rawRedirectUri = form.get('redirect_uri')?.trim() ?? '';
    const state = form.get('state');
    const codeChallenge = form.get('code_challenge')?.trim() ?? '';
    const codeChallengeMethod = form.get('code_challenge_method')?.trim() ?? '';
    const resource = form.get('resource')?.trim() ?? null;
    const scopeParam = form.get('scope');
    const decision = form.get('decision');

    const origin = getAppBaseUrl(request);
    const checkedUri = validateRedirectUri(rawRedirectUri);
    if (!clientId || !checkedUri.ok) {
        return NextResponse.json({ error: 'Invalid client_id or redirect_uri' }, { status: 400 });
    }

    const client = await resolveOAuthClient(clientId);
    if (!client || !client.redirectUris.includes(checkedUri.normalized)) {
        return NextResponse.json({ error: 'Unrecognized client or redirect_uri' }, { status: 400 });
    }

    if (decision === 'deny') {
        logEvent('info', 'oauth.authorize', {
            clientId: client.clientId,
            outcome: 'denied',
        });
        return NextResponse.redirect(
            buildRedirectLocation(checkedUri.normalized, { error: 'access_denied', state }),
            303,
        );
    }

    if (decision !== 'allow') {
        return NextResponse.json({ error: 'Invalid decision' }, { status: 400 });
    }

    if (
        codeChallengeMethod !== 'S256'
        || !isValidCodeChallenge(codeChallenge)
        || !isValidMcpResource(resource, origin)
    ) {
        return NextResponse.json({ error: 'Invalid PKCE or resource parameters' }, { status: 400 });
    }

    const parsedScopes = parseRequestedScopes(scopeParam);
    if (!parsedScopes.ok) {
        return NextResponse.json({ error: parsedScopes.error }, { status: 400 });
    }

    const submittedSiteIds = [...new Set(form.getAll('site_ids').map(id => id.trim()).filter(Boolean))];
    if (submittedSiteIds.length === 0) {
        return NextResponse.json({ error: 'Select at least one home' }, { status: 400 });
    }

    const authorizedSiteIds = new Set(await getAuthorizedSiteIds());
    if (submittedSiteIds.some(siteId => !authorizedSiteIds.has(siteId))) {
        return NextResponse.json({ error: 'Selected home is not authorized' }, { status: 400 });
    }

    const { code } = await createAuthCode({
        clientId: client.clientId,
        clientName: client.clientName,
        clientUri: client.clientUri,
        userId: user.id,
        redirectUri: checkedUri.normalized,
        codeChallenge,
        resource: resource as string,
        scopes: parsedScopes.scopes,
        siteIds: submittedSiteIds,
    });

    // Non-blocking warm-up for newly provisioned sites so initial MCP tool calls have fresh data.
    for (const siteId of submittedSiteIds) {
        void refreshTodayData(siteId).catch(() => undefined);
    }

    logEvent('info', 'oauth.authorize', {
        clientId: client.clientId,
        siteCount: submittedSiteIds.length,
        outcome: 'allowed',
    });

    return NextResponse.redirect(
        buildRedirectLocation(checkedUri.normalized, { code, state }),
        303,
    );
});
