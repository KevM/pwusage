'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function InstallContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const code = searchParams.get('code');
    const installationCallbackUrl = searchParams.get('installation_callback_url');

    const [sites, setSites] = useState<{ id: string, name: string }[]>([]);
    const [selectedSite, setSelectedSite] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [accessToken, setAccessToken] = useState('');

    useEffect(() => {
        // 1. Fetch sites
        fetch('/api/sites')
            .then(res => res.json())
            .then(data => {
                setSites(data);
                if (data.length > 0) setSelectedSite(data[0].id);
            })
            .catch(err => setError('Failed to load sites'))
            .finally(() => setLoading(false));

        // 2. Exchange code for token (if we have a code)
        // Note: In a real app, we should do this server-side to keep client_secret hidden.
        // But for this personal app, we might need a server action or API route to proxy the exchange.
        // Let's assume we have an API route for this or we do it here if we don't care about exposing secret (bad practice).
        // Wait, the plan said "Exchanges the code for an access_token (server-side)".
        // So we need an API route to do the exchange.
        // But we don't have that route yet in the plan?
        // Ah, TrmnlService has exchangeCodeForToken.
        // We need an API route to call it.
        // Let's add that to the plan or just implement it.
        // Actually, the "setup" route takes access_token.
        // So the client needs to get the token? No, that exposes the secret.
        // The client should send the CODE to our backend, and our backend exchanges it.

    }, []);

    const handleSetup = async () => {
        if (!selectedSite || !code) return;
        setLoading(true);

        try {
            // We need to exchange code for token first.
            // Let's create a new API route for this: /api/trmnl/exchange
            // Or just modify /api/trmnl/setup to take the code and do the exchange?
            // Yes, that's better.

            const res = await fetch('/api/trmnl/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code,
                    site_id: selectedSite,
                    // We need to pass the callback URL too? No.
                })
            });

            if (!res.ok) throw new Error(await res.text());

            // Redirect back to Trmnl
            if (installationCallbackUrl) {
                window.location.href = installationCallbackUrl;
            } else {
                alert('Setup complete! You can close this window.');
            }
        } catch (err: any) {
            setError(err.message);
            setLoading(false);
        }
    };

    if (loading) return <div className="p-8">Loading...</div>;
    if (error) return <div className="p-8 text-red-500">Error: {error}</div>;

    return (
        <div className="max-w-md mx-auto mt-10 p-6 bg-white rounded-lg shadow-md">
            <h1 className="text-2xl font-bold mb-6">Connect to Trmnl</h1>

            <div className="mb-4">
                <label className="block text-sm font-medium mb-2">Select Site to Display</label>
                <select
                    value={selectedSite}
                    onChange={e => setSelectedSite(e.target.value)}
                    className="w-full p-2 border rounded"
                >
                    {sites.map(site => (
                        <option key={site.id} value={site.id}>{site.name}</option>
                    ))}
                </select>
            </div>

            <button
                onClick={handleSetup}
                disabled={!selectedSite || !code}
                className="w-full bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 disabled:opacity-50"
            >
                Connect
            </button>
        </div>
    );
}

export default function Page() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <InstallContent />
        </Suspense>
    );
}
