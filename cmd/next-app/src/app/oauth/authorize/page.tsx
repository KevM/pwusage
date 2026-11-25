import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { P } from '@/components/ui/Typography';
import { ClientIdentityNotice } from '@/components/oauth/ClientIdentityNotice';
import { getAuthorizedSites, getCurrentUser } from '@/lib/auth-checks';
import { describeClientIdentity } from '@/lib/oauth/client-identity';
import { resolveOAuthClient } from '@/lib/oauth/client-resolver';
import { createOAuthCsrfToken } from '@/lib/oauth/csrf';
import type { OAuthScope } from '@/lib/oauth/types';
import {
    expectedMcpResource,
    isValidCodeChallenge,
    isValidMcpResource,
    parseRequestedScopes,
    validateRedirectUri,
} from '@/lib/oauth/validation';
import { getAppBaseUrl } from '@/lib/url-utils';

const SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
    'billing:read': 'Read your current bill, rate plan, export cushion, and Smart Shift outlook',
    'usage:read': 'Read live Powerwall status and daily usage history',
};

function renderInvalidRequest(message: string) {
    return (
        <PageShell maxWidth="md">
            <PageHeader title="Authorization request invalid" titleTag="h1" />
            <Card>
                <CardHeader>
                    <CardTitle>Could not connect app</CardTitle>
                    <CardDescription>{message}</CardDescription>
                </CardHeader>
                <CardContent>
                    <P className="text-sm text-muted-foreground">
                        Return to the app that started this connection and try again.
                    </P>
                </CardContent>
            </Card>
        </PageShell>
    );
}

function buildAuthorizePath(params: Record<string, string | undefined>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') {
            query.set(key, value);
        }
    }
    return `/oauth/authorize?${query.toString()}`;
}

export default async function OAuthAuthorizePage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const raw = await searchParams;
    const getParam = (key: string): string | undefined => {
        const value = raw[key];
        return Array.isArray(value) ? value[0] : value;
    };

    const responseType = getParam('response_type');
    const clientId = getParam('client_id')?.trim() ?? '';
    const rawRedirectUri = getParam('redirect_uri')?.trim() ?? '';
    const state = getParam('state');
    const codeChallenge = getParam('code_challenge')?.trim() ?? '';
    const codeChallengeMethod = getParam('code_challenge_method')?.trim() ?? '';
    const rawResource = getParam('resource')?.trim() ?? null;
    const scopeParam = getParam('scope') ?? null;

    if (responseType !== 'code') {
        return renderInvalidRequest('Only response_type=code is supported.');
    }
    if (codeChallengeMethod !== 'S256' || !isValidCodeChallenge(codeChallenge)) {
        return renderInvalidRequest('PKCE with code_challenge_method=S256 is required.');
    }

    const headerList = await headers();
    // Multi-hop proxies send comma-separated lists; the first entry is the client-facing value.
    const firstValue = (name: string) => headerList.get(name)?.split(',', 1)[0]?.trim() || null;
    const host = firstValue('x-forwarded-host') ?? firstValue('host');
    const proto = firstValue('x-forwarded-proto') ?? 'https';
    const requestOrigin = host ? `${proto}://${host}` : undefined;
    const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || requestOrigin || getAppBaseUrl();

    const resource = rawResource === null || rawResource === '' ? expectedMcpResource(origin) : rawResource;
    if (!isValidMcpResource(resource, origin)) {
        return renderInvalidRequest('Invalid MCP resource parameter.');
    }

    const parsedScopes = parseRequestedScopes(scopeParam);
    if (!parsedScopes.ok) {
        return renderInvalidRequest(parsedScopes.error);
    }

    const checkedUri = validateRedirectUri(rawRedirectUri);
    if (!clientId || !checkedUri.ok) {
        return renderInvalidRequest('Invalid client_id or redirect_uri.');
    }

    const client = await resolveOAuthClient(clientId);
    if (!client || !client.redirectUris.includes(checkedUri.uri)) {
        return renderInvalidRequest('Unrecognized app or redirect URI.');
    }

    const identity = describeClientIdentity(client, checkedUri.uri);

    const authorizePath = buildAuthorizePath({
        response_type: responseType,
        client_id: clientId,
        redirect_uri: checkedUri.uri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        resource: resource ?? undefined,
        scope: scopeParam ?? undefined,
    });

    const user = await getCurrentUser();
    if (!user) {
        return (
            <PageShell maxWidth="md">
                <PageHeader title="Connect to PWUsage" titleTag="h1" />
                <Card>
                    <CardHeader>
                        <CardTitle>Sign in with your Tesla account to connect your Powerwall to {client.clientName}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <ClientIdentityNotice identity={identity} />
                        <P>
                            PWUsage uses your Tesla account to read your Powerwall energy data and rate plan, then lets you choose which home to share.
                        </P>
                        <Link
                            href={`/login?callback=${encodeURIComponent(authorizePath)}`}
                            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                        >
                            Continue with Tesla
                        </Link>
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    const sites = await getAuthorizedSites();
    if (sites.length === 0) {
        redirect(`/no-sites?callback=${encodeURIComponent(authorizePath)}`);
    }

    const csrfToken = createOAuthCsrfToken(user.id, {
        clientId: client.clientId,
        redirectUri: checkedUri.uri,
        codeChallenge,
        resource,
        scope: parsedScopes.scopes.join(' '),
    });

    return (
        <PageShell maxWidth="md">
            <PageHeader title={`Authorize ${client.clientName}`} titleTag="h1" />
            <Card>
                <CardHeader>
                    <CardTitle>{client.clientName} wants read-only access</CardTitle>
                </CardHeader>
                <CardContent>
                    <form method="POST" action="/oauth/authorize/decision" className="space-y-6">
                        <ClientIdentityNotice identity={identity} />
                        <input type="hidden" name="csrf_token" value={csrfToken} />
                        <input type="hidden" name="client_id" value={client.clientId} />
                        <input type="hidden" name="redirect_uri" value={checkedUri.uri} />
                        {state && <input type="hidden" name="state" value={state} />}
                        <input type="hidden" name="code_challenge" value={codeChallenge} />
                        <input type="hidden" name="code_challenge_method" value="S256" />
                        <input type="hidden" name="resource" value={resource ?? ''} />
                        <input type="hidden" name="scope" value={parsedScopes.scopes.join(' ')} />

                        <div className="space-y-2">
                            <h2 className="text-sm font-semibold">Homes to share</h2>
                            {sites.length === 1 ? (
                                <div className="rounded-md border border-border px-3 py-2 text-sm">
                                    <input type="hidden" name="site_ids" value={sites[0].id} />
                                    <span className="font-medium">{sites[0].name}</span>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {sites.map(site => (
                                        <label
                                            key={site.id}
                                            className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm cursor-pointer"
                                        >
                                            <input
                                                type="checkbox"
                                                name="site_ids"
                                                value={site.id}
                                                defaultChecked
                                                className="h-4 w-4"
                                            />
                                            <span className="font-medium">{site.name}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="space-y-2">
                            <h2 className="text-sm font-semibold">Permissions</h2>
                            <ul className="list-disc pl-5 space-y-1 text-sm">
                                {parsedScopes.scopes.map(scope => (
                                    <li key={scope}>{SCOPE_DESCRIPTIONS[scope]}</li>
                                ))}
                            </ul>
                            <p className="text-sm text-muted-foreground">
                                Read-only — {client.clientName} cannot change your Powerwall settings.
                            </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                            <Button type="submit" name="decision" value="allow">
                                Allow
                            </Button>
                            <Button type="submit" name="decision" value="deny" variant="secondary" formNoValidate>
                                Deny
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </PageShell>
    );
}
