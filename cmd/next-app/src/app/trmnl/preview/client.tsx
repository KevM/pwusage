'use client';

import { useEffect, useState } from 'react';

export function PreviewClient({ tokens }: { tokens: { access_token: string, site_name: string }[] }) {
    const [selectedToken, setSelectedToken] = useState(tokens[0]?.access_token || '');
    const [html, setHtml] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        if (!selectedToken) return;

        fetch('/api/trmnl/markup', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${selectedToken}`
            }
        })
            .then(res => res.json())
            .then(data => {
                if (data.markup) {
                    setHtml(data.markup);
                } else {
                    setError(JSON.stringify(data));
                }
            })
            .catch(err => setError(err.message));
    }, [selectedToken]);

    if (!selectedToken) return <div className="text-red-500">No tokens available.</div>;

    return (
        <div className="border p-4 rounded shadow-sm bg-gray-50">
            {tokens.length > 1 && (
                <div className="mb-4">
                    <label className="mr-2 font-medium">Select Site:</label>
                    <select
                        className="border p-1 rounded"
                        value={selectedToken}
                        onChange={(e) => setSelectedToken(e.target.value)}
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
