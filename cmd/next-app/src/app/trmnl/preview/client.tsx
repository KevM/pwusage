'use client';

import { useEffect, useState } from 'react';

export function PreviewClient({ token }: { token: string }) {
    const [html, setHtml] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        fetch('/api/trmnl/markup', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
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
    }, [token]);

    if (error) return <div className="text-red-500">Error: {error}</div>;
    if (!html) return <div>Loading...</div>;

    return (
        <div className="border p-4 rounded shadow-sm bg-gray-50">
            <h2 className="text-lg font-semibold mb-2">Rendered Output:</h2>
            {/* Trmnl styles won't be exact here without their CSS, but structure is visible */}
            <div dangerouslySetInnerHTML={{ __html: html }} className="bg-white p-4 border" />

            <h2 className="text-lg font-semibold mt-8 mb-2">Raw HTML:</h2>
            <pre className="bg-gray-800 text-white p-4 rounded overflow-auto text-xs">
                {html}
            </pre>
        </div>
    );
}
