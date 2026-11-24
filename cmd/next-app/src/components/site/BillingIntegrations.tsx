'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input, Label } from '@/components/ui/Form';
import type { IntegrationCredential } from '@/lib/integration-credential-repo';

export function BillingIntegrations({ siteId }: { siteId: string }) {
    const url = `/api/site/${encodeURIComponent(siteId)}/billing-integrations`;
    const [credentials, setCredentials] = useState<IntegrationCredential[] | null>(null);
    const [name, setName] = useState('');
    const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        async function load() {
            try {
                const response = await fetch(url, { signal: controller.signal });
                if (!response.ok) throw new Error();
                const data: { credentials: IntegrationCredential[] } = await response.json();
                setCredentials(data.credentials);
            } catch {
                if (!controller.signal.aborted) setError('Couldn’t load billing integrations.');
            }
        }
        void load();
        return () => controller.abort();
    }, [url]);

    async function createToken(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (!response.ok) throw new Error();
            const data: { credential: IntegrationCredential; token: string } = await response.json();
            setCredentials(previous => [data.credential, ...(previous ?? [])]);
            setCreated({ id: data.credential.id, token: data.token });
            setCopied(false);
            setName('');
        } catch {
            setError('Couldn’t create the integration token.');
        } finally {
            setBusy(false);
        }
    }

    async function revokeToken(id: string) {
        setBusy(true);
        setError('');
        try {
            const response = await fetch(`${url}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!response.ok && response.status !== 404) throw new Error();
            setCredentials(previous => previous?.filter(credential => credential.id !== id) ?? []);
            setCreated(previous => previous?.id === id ? null : previous);
        } catch {
            setError('Couldn’t revoke the integration token.');
        } finally {
            setBusy(false);
        }
    }

    async function copyToken(token: string) {
        try {
            await navigator.clipboard.writeText(token);
            setCopied(true);
        } catch {
            setError('Couldn’t copy the token. Select the token and copy it manually.');
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Billing Integrations</CardTitle>
                <CardDescription>Give another app read-only access to this home’s current bill and rate period banks.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-1 text-sm">
                    <p>Send a GET request to <code className="break-all">/api/integrations/v1/billing</code> with <code>Authorization: Bearer &lt;token&gt;</code>.</p>
                    <p>Send the returned ETag as <code>If-None-Match</code> on later requests. A 304 response means you can reuse the previous bill.</p>
                </div>
                <form onSubmit={createToken} className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 space-y-1">
                        <Label htmlFor="billing-integration-name">Integration name</Label>
                        <Input id="billing-integration-name" value={name} maxLength={80} required
                            onChange={event => setName(event.target.value)} placeholder="Home Assistant" />
                    </div>
                    <Button type="submit" disabled={busy || credentials === null || !name.trim()}>Create Token</Button>
                </form>
                {created && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                        <Label htmlFor="billing-integration-token">Copy this token now. It’s shown once.</Label>
                        <Input id="billing-integration-token" className="font-mono" readOnly value={created.token}
                            onFocus={event => event.currentTarget.select()} />
                        <Button type="button" variant="secondary" onClick={() => void copyToken(created.token)}>
                            {copied ? 'Copied' : 'Copy Token'}
                        </Button>
                    </div>
                )}
                {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
                {credentials && credentials.length > 0 && (
                    <ul className="divide-y divide-border">
                        {credentials.map(credential => (
                            <li key={credential.id} className="flex items-center justify-between gap-3 py-2">
                                <span className="min-w-0 break-words text-sm font-medium">{credential.name}</span>
                                <Button type="button" variant="secondary" disabled={busy}
                                    aria-label={`Revoke token for ${credential.name}`}
                                    onClick={() => void revokeToken(credential.id)}>Revoke</Button>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}
