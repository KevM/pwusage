'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function ManageContent() {
    const searchParams = useSearchParams();
    const uuid = searchParams.get('uuid');

    const [sites, setSites] = useState<{ id: string, name: string }[]>([]);
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
        Promise.all([
            fetch('/api/sites').then(res => res.json()),
            fetch(`/api/trmnl/manage?uuid=${uuid}`).then(res => res.json())
        ])
            .then(([sitesData, installData]) => {
                setSites(sitesData);
                if (installData.site_id) setSelectedSite(installData.site_id);
                else if (sitesData.length > 0) setSelectedSite(sitesData[0].id);
            })
            .catch(err => setError('Failed to load data'))
            .finally(() => setLoading(false));
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

    return (
        <div className="max-w-md mx-auto mt-10 p-6 bg-white rounded-lg shadow-md">
            <h1 className="text-2xl font-bold mb-6">Manage Trmnl Connection</h1>

            {success && <div className="mb-4 p-2 bg-green-100 text-green-700 rounded">{success}</div>}

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
                <div className="mb-4">
                    <p className="text-sm font-medium mb-1">Link to Site:</p>
                    <p className="font-bold">{sites[0].name}</p>
                    <input type="hidden" value={sites[0].id} />
                </div>
            ) : (
                <div className="mb-4 text-red-500">No sites found. Please set up a site first.</div>
            )}

            <button
                onClick={handleSave}
                disabled={!selectedSite}
                className="w-full bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 disabled:opacity-50"
            >
                Save Changes
            </button>
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
