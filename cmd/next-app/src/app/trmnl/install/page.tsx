'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function InstallContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const code = searchParams.get('code');
    const installationCallbackUrl = searchParams.get('installation_callback_url');
    const installationUuid = searchParams.get('installation_uuid');

    const [sites, setSites] = useState<{ id: string, name: string }[]>([]);
    const [selectedSite, setSelectedSite] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [autoConnecting, setAutoConnecting] = useState(false);

    // Effect to handle initial data load and auto-connection
    useEffect(() => {
        if (!code) return; // Wait for code

        let redirecting = false;

        // 1. Fetch sites
        fetch('/api/sites')
            .then(async res => {
                if (res.status === 401) {
                    redirecting = true;
                    // Construct callback URL with all current parameters
                    const currentSearch = window.location.search;
                    const callbackUrl = encodeURIComponent(`/trmnl/install${currentSearch}`);
                    window.location.href = `/login?callback=${callbackUrl}`;
                    return null;
                }
                return res.json();
            })
            .then(data => {
                if (!data) return; // Handled redirect or error

                setSites(data);
                if (data.length > 0) {
                    const firstSiteId = data[0].id;
                    setSelectedSite(firstSiteId);

                    // Auto-connect if only one site
                    if (data.length === 1) {
                        setAutoConnecting(true);
                        // triggerSetup(firstSiteId, code); // Call separate function to avoid stale state issues in effect? 
                        // Actually, we can just call the setup logic here directly or use a ref.
                        // Let's call a minimal version of handleSetup here.
                        performSetup(firstSiteId, code, installationCallbackUrl, installationUuid);
                    }
                }
            })
            .catch(err => setError('Failed to load sites'))
            .finally(() => {
                if (!redirecting && !autoConnecting) setLoading(false);
            });
    }, [code, installationCallbackUrl, installationUuid]); // Only run once on mount (with code)

    const performSetup = async (siteId: string, authCode: string, callbackUrl: string | null, uuid: string | null) => {
        try {
            const res = await fetch('/api/trmnl/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: authCode,
                    site_id: siteId,
                    uuid: uuid
                })
            });

            if (!res.ok) throw new Error(await res.text());

            // Redirect back to Trmnl
            if (callbackUrl) {
                window.location.href = callbackUrl;
            } else {
                alert('Setup complete! You can close this window.');
            }
        } catch (err: any) {
            setError(err.message);
            setLoading(false);
            setAutoConnecting(false);
        }
    };

    const handleSetup = () => {
        performSetup(selectedSite, code!, installationCallbackUrl, installationUuid);
    };

    if (loading || autoConnecting) return (
        <div className="max-w-md mx-auto mt-10 p-8 bg-white rounded-lg shadow-md text-center">
            <h1 className="text-xl font-bold mb-4">Connecting to Trmnl...</h1>
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
            {autoConnecting && sites.length > 0 && <p className="mt-4 text-gray-600">Linking to {sites[0].name}</p>}
        </div>
    );

    if (error) return <div className="p-8 text-red-500">Error: {error}</div>;

    return (
        <div className="max-w-md mx-auto mt-10 p-6 bg-white rounded-lg shadow-md">
            <h1 className="text-2xl font-bold mb-6">Connect to Trmnl</h1>

            {sites.length > 1 ? (
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
            ) : sites.length === 1 ? (
                // Should generally not be reached due to auto-connect, but good fallback
                <div className="mb-4">
                    <p className="text-sm font-medium mb-1">Link to Site:</p>
                    <p className="font-bold">{sites[0].name}</p>
                </div>
            ) : (
                <div className="mb-4 text-red-500">No sites found. Please set up a site first.</div>
            )}

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
