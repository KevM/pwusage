'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { Breadcrumbs } from '@/components/Breadcrumbs';

function ManageContent() {
    const searchParams = useSearchParams();
    const uuid = searchParams.get('uuid');

    const [sites, setSites] = useState<{ id: string, name: string, utility: string }[]>([]);
    const [selectedSite, setSelectedSite] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    useEffect(() => {
        if (!uuid) {
            setError('Missing UUID');
            setLoading(false);
            return;
        }

        // Fetch sites and current installation
        const fetchData = async () => {
            let redirecting = false;
            try {
                const [sitesRes, installRes] = await Promise.all([
                    fetch('/api/sites'),
                    fetch(`/api/trmnl/manage?uuid=${uuid}`)
                ]);

                if (sitesRes.status === 401 || installRes.status === 401) {
                    redirecting = true;
                    const callbackUrl = encodeURIComponent(`/trmnl/manage?uuid=${uuid}`);
                    window.location.href = `/login?callback=${callbackUrl}`;
                    return;
                }

                const sitesData = await sitesRes.json();
                const installData = await installRes.json();

                setSites(sitesData);
                if (installData.site_id) setSelectedSite(installData.site_id);
                else if (sitesData.length > 0) setSelectedSite(sitesData[0].id);
            } catch (err) {
                setError('Failed to load data');
            } finally {
                if (!redirecting) setLoading(false);
            }
        };

        fetchData();
    }, [uuid]);

    const handleSave = async () => {
        if (!selectedSite || !uuid) return;
        setLoading(true);
        setSuccess('');
        setError('');

        try {
            const res = await fetch('/api/trmnl/manage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uuid,
                    site_id: selectedSite
                })
            });

            if (!res.ok) throw new Error(await res.text());
            setSuccess('Settings saved!');
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    if (loading) return <div className="p-8">Loading...</div>;
    if (error) return <div className="p-8 text-red-500">Error: {error}</div>;

    const currentSite = sites.find(s => s.id === selectedSite);

    return (
        <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="w-full max-w-2xl">
                {currentSite && (
                    <Breadcrumbs items={[
                        { label: 'Dashboard', href: '/' },
                        { label: currentSite.name, href: `/site/${currentSite.id}` },
                        { label: 'Settings', href: `/site/${currentSite.id}/settings` },
                        { label: 'Trmnl Connect' }
                    ]} />
                )}
                {!currentSite && (
                    <Breadcrumbs items={[
                        { label: 'Dashboard', href: '/' },
                        { label: 'Trmnl Connect' }
                    ]} />
                )}

                <div className="mt-8 bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800">
                    <h1 className="text-2xl font-bold mb-6">Manage Trmnl Connection</h1>

                    {success && <div className="mb-4 p-2 bg-green-100 text-green-700 rounded">{success}</div>}

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
                        <div className="mb-6">
                            <p className="text-sm font-medium mb-1 text-gray-500">Link to Site:</p>
                            <p className="font-bold text-lg">{sites[0].name}</p>
                            <input type="hidden" value={sites[0].id} />
                        </div>
                    ) : (
                        <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/30 rounded border border-yellow-200 dark:border-yellow-700">
                            <h3 className="font-semibold text-yellow-800 dark:text-yellow-200 mb-2">No Energy Sites Found</h3>
                            <p className="text-sm text-yellow-700 dark:text-yellow-300 mb-4">
                                We couldn't find any compatible energy sites associated with your account.
                            </p>
                            <a href="/" className="text-sm font-medium text-blue-600 hover:text-blue-500 underline">
                                Return to Dashboard
                            </a>
                        </div>
                    )}

                    {currentSite && (
                        <div className="mb-8 p-4 bg-gray-50 dark:bg-slate-800 rounded-lg">
                            <h3 className="font-semibold mb-2 text-gray-900 dark:text-white">Selected Site Details</h3>
                            <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                    <span className="block text-gray-500 dark:text-gray-400">Site Name</span>
                                    <span className="font-medium">{currentSite.name}</span>
                                </div>
                                <div>
                                    <span className="block text-gray-500 dark:text-gray-400">Utility Provider</span>
                                    <span className="font-medium">{currentSite.utility}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    <button
                        onClick={handleSave}
                        disabled={!selectedSite}
                        className="w-full bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                        Save Changes
                    </button>

                    <div className="mt-4 text-center">
                        <a href={`https://usetrmnl.com/plugin_settings/${uuid}/edit?force_refresh=true`} target="_blank" rel="noreferrer" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                            Back to Trmnl Dashboard
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
            <ManageContent />
        </Suspense>
    );
}
