'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input, Label } from '@/components/ui/Form';
import type { UserOAuthGrantSummary } from '@/lib/oauth/oauth-repo';
import { BILLING_ENDPOINT, IntegrationTokenExamples } from './IntegrationTokenExamples';
import { SignOutEverywhere } from './SignOutEverywhere';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Every connection to this home, apps and integration tokens alike, in one request. */
export async function requestConnections(siteId: string, fetchFn: FetchFn = fetch, signal?: AbortSignal) {
    const res = await fetchFn(`/api/oauth/grants?siteId=${encodeURIComponent(siteId)}`, { signal });
    if (!res.ok) throw new Error(`Couldn’t load connections (${res.status})`);
    const data = (await res.json()) as { grants: UserOAuthGrantSummary[] };
    return data.grants;
}

/** Creates an integration token. The raw token is in this response only. */
export async function requestCreateToken(siteId: string, name: string, fetchFn: FetchFn = fetch) {
    const res = await fetchFn('/api/oauth/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, name }),
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof body?.error === 'string' ? body.error : 'Couldn’t create the integration token.');
    }
    return (await res.json()) as { grant: UserOAuthGrantSummary; token: string };
}

/** Disconnects an app or revokes a token. A 404 means it is already gone. */
export async function requestRevoke(grantId: string, fetchFn: FetchFn = fetch): Promise<boolean> {
    try {
        const res = await fetchFn(`/api/oauth/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
        return res.ok || res.status === 404;
    } catch {
        return false;
    }
}

export const withCreated = (grants: UserOAuthGrantSummary[], grant: UserOAuthGrantSummary) => [grant, ...grants];
export const withoutGrant = (grants: UserOAuthGrantSummary[], grantId: string) => grants.filter(g => g.id !== grantId);

function formatShortDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function ConnectionRow({ grant, busy, onRevoke }: {
    grant: UserOAuthGrantSummary;
    busy: boolean;
    onRevoke: (grantId: string) => void;
}) {
    const isToken = grant.kind === 'token';
    const source = isToken
        ? 'Integration token · Billing'
        : grant.publisherHost ? `App details from ${grant.publisherHost}` : 'Unverified app';
    const action = isToken ? 'Revoke' : 'Disconnect';
    return (
        <li className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium break-words">{grant.clientName}</p>
                <p className="text-xs text-muted-foreground break-words">{source}</p>
                <p className="text-xs text-muted-foreground">
                    {isToken ? 'Created' : 'Connected'} {formatShortDate(grant.createdAt)}
                    {grant.lastUsedAt ? ` · Last used ${formatShortDate(grant.lastUsedAt)}` : ' · Never used'}
                    {grant.siteCount > 1 ? ` · Shared across ${grant.siteCount} homes` : ''}
                </p>
            </div>
            <Button type="button" variant="secondary" disabled={busy}
                aria-label={`${action} ${grant.clientName}`} onClick={() => onRevoke(grant.id)}>
                {action}
            </Button>
        </li>
    );
}

export function ConnectionsList({ grants, busyId, onRevoke }: {
    grants: UserOAuthGrantSummary[];
    busyId: string | null;
    onRevoke: (grantId: string) => void;
}) {
    if (grants.length === 0) {
        return <p className="text-sm text-muted-foreground">Nothing is connected to this home yet.</p>;
    }
    return (
        <ul className="divide-y divide-border">
            {grants.map(grant => (
                <ConnectionRow key={grant.id} grant={grant} busy={busyId === grant.id} onRevoke={onRevoke} />
            ))}
        </ul>
    );
}

export function CreatedToken({ token, copied, onCopy }: { token: string; copied: boolean; onCopy: () => void }) {
    return (
        <div className="space-y-2 rounded-md border border-border p-3">
            <Label htmlFor="integration-token-value">Copy this token now. It’s shown once.</Label>
            <Input id="integration-token-value" className="font-mono" readOnly value={token}
                onFocus={event => event.currentTarget.select()} />
            <Button type="button" variant="secondary" onClick={onCopy}>{copied ? 'Copied' : 'Copy Token'}</Button>
        </div>
    );
}

export function Connections({ siteId }: { siteId: string }) {
    const [grants, setGrants] = useState<UserOAuthGrantSummary[] | null>(null);
    const [name, setName] = useState('');
    const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        requestConnections(siteId, fetch, controller.signal)
            .then(setGrants)
            .catch(() => { if (!controller.signal.aborted) setError('Couldn’t load connections.'); });
        return () => controller.abort();
    }, [siteId]);

    async function createToken(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const result = await requestCreateToken(siteId, name);
            setGrants(previous => withCreated(previous ?? [], result.grant));
            setCreated({ id: result.grant.id, token: result.token });
            setCopied(false);
            setName('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Couldn’t create the integration token.');
        } finally {
            setBusy(false);
        }
    }

    async function revoke(grantId: string) {
        setBusyId(grantId);
        setError('');
        if (await requestRevoke(grantId)) {
            setGrants(previous => withoutGrant(previous ?? [], grantId));
            setCreated(previous => previous?.id === grantId ? null : previous);
        } else {
            setError('Couldn’t revoke this connection.');
        }
        setBusyId(null);
    }

    async function copyToken(token: string) {
        try {
            await navigator.clipboard.writeText(token);
            setCopied(true);
        } catch {
            setError('Couldn’t copy the token. Select the token and copy it manually.');
        }
    }

    const hasToken = grants?.some(grant => grant.kind === 'token') ?? false;
    return (
        <Card>
            <CardHeader>
                <CardTitle>Connections</CardTitle>
                <CardDescription>AI apps and integration tokens that can read this home’s data.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
                {grants === null && !error && <p className="text-sm text-muted-foreground">Loading connections…</p>}
                {grants && <ConnectionsList grants={grants} busyId={busyId} onRevoke={id => void revoke(id)} />}
                <div className="space-y-1 text-sm">
                    <p>An integration token gives a script read-only access to this home’s current bill and rate period banks.</p>
                    <p>Send a GET request to <code className="break-all">{BILLING_ENDPOINT}</code> with <code>Authorization: Bearer &lt;token&gt;</code>.</p>
                    <p>Send the returned ETag as <code>If-None-Match</code> on later requests. A 304 response means you can reuse the previous bill.</p>
                </div>
                <form onSubmit={createToken} className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 space-y-1">
                        <Label htmlFor="integration-token-name">Integration name</Label>
                        <Input id="integration-token-name" value={name} maxLength={80} required
                            onChange={event => setName(event.target.value)} placeholder="Home Assistant" />
                    </div>
                    <Button type="submit" disabled={busy || grants === null || !name.trim()}>Create Token</Button>
                </form>
                {created && <CreatedToken token={created.token} copied={copied} onCopy={() => void copyToken(created.token)} />}
                {hasToken && <IntegrationTokenExamples />}
                <SignOutEverywhere />
            </CardContent>
        </Card>
    );
}
