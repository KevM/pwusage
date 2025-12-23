'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { Breadcrumbs } from '@/components/Breadcrumbs';

function InstallContent() {
    const searchParams = useSearchParams();
    const code = searchParams.get('code');
    const installationCallbackUrl = searchParams.get('installation_callback_url');

    // detailed_install_url has the uuid in it usually, but we also look for uuid or installation_uuid
    let installationUuid = searchParams.get('installation_uuid') || searchParams.get('uuid');

    // Fallback: extract from callback URL if present
    if (!installationUuid && installationCallbackUrl) {
        const match = installationCallbackUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (match) {
            installationUuid = match[0];
        }
    }

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
        fetch('/api/sites', { credentials: 'include' })
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
                        // Extract plugin ID here too for auto-connect
                        let pluginSettingId: string | null = null;
                        if (installationCallbackUrl) {
                            const match = installationCallbackUrl.match(/\/plugin_settings\/(\d+)/);
                            if (match) pluginSettingId = match[1];
                        }
                        performSetup(firstSiteId, code, installationCallbackUrl, installationUuid, pluginSettingId);
                    } else {
                        if (!redirecting) setLoading(false);
                    }
                } else {
                    if (!redirecting) setLoading(false);
                }
            })
            .catch(() => {
                setError('Failed to load sites');
                setLoading(false);
            });
    }, [code, installationCallbackUrl, installationUuid]); // Only run once on mount (with code)

    const performSetup = async (siteId: string, authCode: string, callbackUrl: string | null, uuid: string | null, pluginSettingId: string | null = null) => {
        try {
            const res = await fetch('/api/trmnl/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    code: authCode,
                    site_id: siteId,
                    uuid: uuid,
                    plugin_setting_id: pluginSettingId
                })
            });

            if (!res.ok) throw new Error(await res.text());

            // Redirect back to Trmnl
            if (callbackUrl) {
                window.location.href = callbackUrl;
            } else {
                alert('Setup complete! You can close this window.');
            }
        } catch (err) {
            setError((err as Error).message);
            setLoading(false);
            setAutoConnecting(false);
        }
    };

    const handleSetup = () => {
        // Extract plugin_setting_id from callback URL if possible for robust linking
        let pluginSettingId: string | null = null;
        if (installationCallbackUrl) {
            const match = installationCallbackUrl.match(/\/plugin_settings\/(\d+)/);
            if (match) {
                pluginSettingId = match[1];
            }
        }
        performSetup(selectedSite, code!, installationCallbackUrl, installationUuid, pluginSettingId);
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
        <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="w-full max-w-2xl">
                <Breadcrumbs items={[
                    { label: 'Install' }
                ]} />

                <div className="mt-8 bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800">
                    <h1 className="text-2xl font-bold mb-6">Connect to Trmnl</h1>

                    {sites.length > 1 ? (
                        <div className="mb-6">
                            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Select Site to Display</label>
                            <select
                                value={selectedSite}
                                onChange={e => setSelectedSite(e.target.value)}
                                className="w-full p-2 border rounded dark:bg-slate-800 dark:border-slate-700"
                            >
                                {sites.map(site => (
                                    <option key={site.id} value={site.id}>{site.name}</option>
                                ))}
                            </select>
                        </div>
                    ) : sites.length === 1 ? (
                        // Should generally not be reached due to auto-connect, but good fallback
                        <div className="mb-6">
                            <p className="text-sm font-medium mb-1 text-gray-500">Link to Site:</p>
                            <p className="font-bold text-lg">{sites[0].name}</p>
                        </div>
                    ) : (
                        <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/30 rounded border border-yellow-200 dark:border-yellow-700">
                            <h3 className="font-semibold text-yellow-800 dark:text-yellow-200 mb-2">No Energy Sites Found</h3>
                            <p className="text-sm text-yellow-700 dark:text-yellow-300 mb-4">
                                We couldn&apos;t find any compatible energy sites associated with your account.
                            </p>
                        </div>
                    )}

                    <div className="flex gap-4">
                        <button
                            onClick={handleSetup}
                            disabled={!selectedSite || !code}
                            className="flex-1 bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
                        >
                            Connect
                        </button>

                        <a
                            href="https://usetrmnl.com/plugin_settings/new?keyname=powerwall_energy_usage"
                            target="_blank"
                            rel="noreferrer"
                            className="flex-1 bg-gray-100 text-gray-700 py-2 px-4 rounded hover:bg-gray-200 text-center transition-colors dark:bg-slate-800 dark:text-gray-300 dark:hover:bg-slate-700"
                        >
                            Back to Trmnl
                        </a>
                    </div>
                </div>
            </div>
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
