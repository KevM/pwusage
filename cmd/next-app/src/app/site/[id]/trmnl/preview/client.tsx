'use client';

import { useState, useEffect } from 'react';

interface Installation {
    site_id: string;
    site_name: string;
    trmnl_uuid: string;
    trmnl_token: string;
}

export function PreviewClient({ installation, manualUuid, siteId }: { installation?: Installation, manualUuid?: string, siteId?: string }) {
    const [html, setHtml] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        let active = true;

        const fetchData = async () => {
            setHtml('');
            setError('');

            try {
                let url = '';
                let headers: HeadersInit = {};

                if (manualUuid) {
                    url = `/api/trmnl/markup?uuid=${manualUuid}`;
                } else if (installation && installation.trmnl_uuid) {
                    url = `/api/trmnl/markup?uuid=${installation.trmnl_uuid}`;
                    if (installation.trmnl_token) {
                        headers = { 'Authorization': `Bearer ${installation.trmnl_token}` };
                    }
                } else if (siteId) {
                    // Fallback: Preview using site ID (requires cookie auth)
                    url = `/api/trmnl/markup?site_id=${siteId}`;
                }

                if (!url) return;

                const res = await fetch(url, { headers, credentials: 'include' });
                const data = await res.json();

                if (active) {
                    if (data.markup) setHtml(data.markup);
                    else setError(JSON.stringify(data));
                }
            } catch (err) {
                if (active) setError((err as Error).message);
            }
        };

        fetchData();

        return () => { active = false; };
    }, [installation, manualUuid, siteId]);

    if (!installation && !manualUuid && !siteId) return <div className="text-red-500">No installation found for this site.</div>;

    return (
        <div className="border p-4 rounded shadow-sm bg-gray-50 dark:bg-slate-800 dark:border-slate-700">
            {error && <div className="text-red-500 mb-4">Error: {error}</div>}

            {!html && !error && <div className="dark:text-gray-300">Loading preview...</div>}

            {html && (
                <>
                    <h2 className="text-lg font-semibold mb-2 dark:text-gray-200">Rendered Output:</h2>
                    <div dangerouslySetInnerHTML={{ __html: html }} className="bg-white text-black p-4 border dark:border-gray-600 rounded" />

                    <h2 className="text-lg font-semibold mt-8 mb-2 dark:text-gray-200">Raw HTML:</h2>
                    <pre className="bg-gray-800 text-white p-4 rounded overflow-auto text-xs">
                        {html}
                    </pre>
                </>
            )}
        </div>
    );
}
