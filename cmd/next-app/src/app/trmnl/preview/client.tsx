'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';

export function PreviewClient({ tokens, initialSiteId, manualUuid }: { tokens?: { access_token: string, site_name: string, site_id: string }[], initialSiteId?: string, manualUuid?: string }) {
    const router = useRouter();
    const pathname = usePathname();
    const initialToken = tokens?.find(t => t.site_id === initialSiteId)?.access_token || tokens?.[0]?.access_token;
    const [selectedToken, setSelectedToken] = useState(initialToken);
    const [html, setHtml] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        if (manualUuid) return;
        const token = tokens?.find(t => t.site_id === initialSiteId)?.access_token || tokens?.[0]?.access_token;
        if (token) setSelectedToken(token);
    }, [initialSiteId, tokens, manualUuid]);

    useEffect(() => {
        if (manualUuid) {
            // Manual UUID fetch (public endpoint)
            fetch(`/api/trmnl/markup?uuid=${manualUuid}`)
                .then(res => res.json())
                .then(data => {
                    if (data.markup) setHtml(data.markup);
                    else setError(JSON.stringify(data));
                })
                .catch(err => setError(err.message));
            return;
        }

        // TODO: Implement preview for authenticated sites by looking up installation UUID from site_id
        // For now, we prefer manual UUID entry for testing.
    }, [selectedToken, manualUuid]);

    const handleSiteChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newToken = e.target.value;
        setSelectedToken(newToken);
        const siteId = tokens?.find(t => t.access_token === newToken)?.site_id;
        if (siteId) {
            router.push(`${pathname}?site_id=${siteId}`);
        }
    };

    if (!selectedToken && !manualUuid) return <div className="text-red-500">No tokens available.</div>;

    return (
        <div className="border p-4 rounded shadow-sm bg-gray-50">
            {tokens && tokens.length > 1 && (
                <div className="mb-4">
                    <label className="mr-2 font-medium">Select Site:</label>
                    <select
                        className="border p-1 rounded"
                        value={selectedToken}
                        onChange={handleSiteChange}
                    >
                        {tokens.map((t, i) => (
                            <option key={i} value={t.access_token}>
                                {t.site_name || `Site ${i + 1}`}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {error && <div className="text-red-500 mb-4">Error: {error}</div>}

            {!html && !error && <div>Loading...</div>}

            {html && (
                <>
                    <h2 className="text-lg font-semibold mb-2">Rendered Output:</h2>
                    {/* Trmnl styles won't be exact here without their CSS, but structure is visible */}
                    <div dangerouslySetInnerHTML={{ __html: html }} className="bg-white text-black p-4 border" />

                    <h2 className="text-lg font-semibold mt-8 mb-2">Raw HTML:</h2>
                    <pre className="bg-gray-800 text-white p-4 rounded overflow-auto text-xs">
                        {html}
                    </pre>
                </>
            )}
        </div>
    );
}
