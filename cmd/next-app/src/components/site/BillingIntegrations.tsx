'use client';

import { useEffect, useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input, Label } from '@/components/ui/Form';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import type { IntegrationCredential } from '@/lib/integration-credential-repo';

const BILLING_ENDPOINT = '/api/integrations/v1/billing';

// The origin is fixed for the lifetime of this page and only available in the browser.
const subscribeToOrigin = () => () => {};
const browserOrigin = () => window.location.origin;
const serverOrigin = () => 'https://your-pwusage-host';

function BillingIntegrationExamples() {
    const id = useId();
    const [tab, setTab] = useState('curl');
    const origin = useSyncExternalStore(subscribeToOrigin, browserOrigin, serverOrigin);
    const endpoint = new URL(BILLING_ENDPOINT, origin).href;
    const curlExample = `curl --include --header "Authorization: Bearer $PWUSAGE_TOKEN" "${endpoint}"`;
    const powerShellExample = `$response = Invoke-WebRequest -UseBasicParsing -Uri '${endpoint.replaceAll("'", "''")}' -Headers @{
    Authorization = "Bearer $env:PWUSAGE_TOKEN"
}
$response.StatusCode
$response.Headers['ETag']
$response.Content`;
    const nodeExample = `const token = process.env.PWUSAGE_TOKEN;
if (!token) throw new Error('Set PWUSAGE_TOKEN first.');

const response = await fetch(${JSON.stringify(endpoint)}, {
    headers: { Authorization: 'Bearer ' + token },
});

console.log('HTTP', response.status);
console.log('ETag', response.headers.get('etag'));
console.log(await response.text());`;

    const examples = [
        { value: 'curl', label: 'curl', code: curlExample },
        { value: 'powershell', label: 'PowerShell', code: powerShellExample },
        {
            value: 'node', label: 'Node.js', code: nodeExample,
            instruction: <>Save this as <code>test-billing.mjs</code> and run <code>node test-billing.mjs</code>.</>,
        },
    ];

    return (
        <Tabs value={tab} onValueChange={setTab} className="min-w-0 space-y-3 rounded-md border border-border p-3 text-sm">
            <p>Set the <code>PWUSAGE_TOKEN</code> environment variable to the token you created. A successful request returns HTTP 200 and the current bill.</p>
            <TabsList aria-label="Billing endpoint examples" onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                const step = event.key === 'ArrowRight' ? 1 : -1;
                event.preventDefault();
                const current = examples.findIndex(example => example.value === tab);
                const next = (current + step + examples.length) % examples.length;
                event.currentTarget.querySelectorAll('button')[next]?.focus();
                setTab(examples[next].value);
            }}>
                {examples.map(({ value, label }) => (
                    <TabsTrigger key={value} id={`${id}-${value}`} value={value}
                        aria-controls={`${id}-${value}-example`} tabIndex={tab === value ? 0 : -1}>
                        {label}
                    </TabsTrigger>
                ))}
            </TabsList>
            {examples.map(({ value, code, instruction }) => (
                <div key={value} id={`${id}-${value}-example`} role="tabpanel" aria-labelledby={`${id}-${value}`}
                    hidden={tab !== value} tabIndex={0} className="space-y-2">
                    {instruction && <p>{instruction}</p>}
                    <pre className="overflow-x-auto rounded-md bg-bg-muted p-3"><code>{code}</code></pre>
                </div>
            ))}
        </Tabs>
    );
}

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
                    <p>Send a GET request to <code className="break-all">{BILLING_ENDPOINT}</code> with <code>Authorization: Bearer &lt;token&gt;</code>.</p>
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
                <BillingIntegrationExamples />
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
