'use client';

import { useId, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';

export const BILLING_ENDPOINT = '/api/integrations/v1/billing';

// The origin is fixed for the lifetime of this page and only available in the browser.
const subscribeToOrigin = () => () => {};
const browserOrigin = () => window.location.origin;
const serverOrigin = () => 'https://your-pwusage-host';

/** How to call the billing endpoint with an integration token: curl, PowerShell and Node.js. */
export function IntegrationTokenExamples() {
    const { toast } = useToast();
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

    async function copyExample(code: string) {
        try {
            await navigator.clipboard.writeText(code);
            toast({ title: 'Example copied', variant: 'success' });
        } catch {
            toast({ title: 'Couldn’t copy the example', description: 'Select the example and copy it manually.', variant: 'danger' });
        }
    }

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
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        {instruction && <p className="flex-1">{instruction}</p>}
                        <Button type="button" variant="outline" size="sm" onClick={() => void copyExample(code)}>
                            {value === 'curl' ? 'Copy Command' : 'Copy Example'}
                        </Button>
                    </div>
                    <pre className="overflow-x-auto rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:border-slate-700 dark:bg-slate-800/60 dark:text-gray-200"><code>{code}</code></pre>
                </div>
            ))}
        </Tabs>
    );
}
