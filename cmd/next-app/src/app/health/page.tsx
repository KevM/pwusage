'use client';

import { useState, useEffect } from 'react';

import type { HealthChecks } from '../api/health/route';

export default function HealthPage() {
    const [data, setData] = useState<HealthChecks | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const fetchHealth = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/health');
            const json = await res.json();
            setData(json);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchHealth();
    }, []);

    const StatusBadge = ({ status }: { status: string }) => {
        let color = 'bg-gray-100 text-gray-800';
        if (status === 'ok') color = 'bg-green-100 text-green-800';
        if (status === 'error') color = 'bg-red-100 text-red-800';
        if (status === 'warning') color = 'bg-yellow-100 text-yellow-800';

        return (
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${color}`}>
                {status.toUpperCase()}
            </span>
        );
    };

    if (loading) return <div className="p-8">Running diagnostics...</div>;
    if (error) return <div className="p-8 text-red-500">Failed to load health check: {error}</div>;

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-zinc-900 p-8">
            <div className="max-w-4xl mx-auto">
                <div className="flex justify-between items-center mb-8">
                    <h1 className="text-3xl font-bold dark:text-white">System Health Check</h1>
                    <button
                        onClick={fetchHealth}
                        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
                    >
                        Refresh
                    </button>
                </div>

                <div className="grid gap-6">
                    {/* Database */}
                    <div className="bg-white dark:bg-zinc-800 p-6 rounded-lg shadow">
                        <div className="flex justify-between items-start mb-4">
                            <h2 className="text-xl font-semibold dark:text-gray-200">Database</h2>
                            {data?.database && <StatusBadge status={data.database.status} />}
                        </div>
                        <p className="text-gray-600 dark:text-gray-400 font-mono text-sm">
                            {data?.database?.message}
                        </p>
                    </div>

                    {/* Data / Schema */}
                    <div className="bg-white dark:bg-zinc-800 p-6 rounded-lg shadow">
                        <div className="flex justify-between items-start mb-4">
                            <h2 className="text-xl font-semibold dark:text-gray-200">Data Storage</h2>
                            {data?.schema && <StatusBadge status={data.schema.status} />}
                        </div>

                        {data?.schema?.details && (
                            <div className="grid grid-cols-3 gap-4 text-center">
                                <div className="bg-gray-50 dark:bg-zinc-700 p-3 rounded">
                                    <div className="text-2xl font-bold dark:text-white">{data.schema.details?.sites as number}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400">Sites</div>
                                </div>
                                <div className="bg-gray-50 dark:bg-zinc-700 p-3 rounded">
                                    <div className="text-2xl font-bold dark:text-white">{data.schema.details?.energyDataRows as number}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400">Data Rows</div>
                                </div>
                                <div className="bg-gray-50 dark:bg-zinc-700 p-3 rounded">
                                    <div className="text-2xl font-bold dark:text-white">{data.schema.details?.energyUsageRows as number}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400">Usage Rows</div>
                                </div>
                            </div>
                        )}
                        <p className="text-red-500 mt-2 text-sm">{data?.schema?.message}</p>
                    </div>

                    {/* Tesla API */}
                    <div className="bg-white dark:bg-zinc-800 p-6 rounded-lg shadow">
                        <div className="flex justify-between items-start mb-4">
                            <h2 className="text-xl font-semibold dark:text-gray-200">Tesla API</h2>
                            {data?.tesla && <StatusBadge status={data.tesla.status} />}
                        </div>
                        <p className="text-gray-600 dark:text-gray-400 font-mono text-sm mb-2">
                            {data?.tesla?.message}
                        </p>
                        {data?.tesla?.products && (
                            <ul className="list-disc list-inside text-sm text-gray-500 dark:text-gray-400">
                                {data.tesla.products.map((p) => (
                                    <li key={p.id}>{p.site_name} (ID: {p.id})</li>
                                ))}
                            </ul>
                        )}
                    </div>

                    {/* Env */}
                    <div className="bg-white dark:bg-zinc-800 p-6 rounded-lg shadow">
                        <div className="flex justify-between items-start mb-4">
                            <h2 className="text-xl font-semibold dark:text-gray-200">Environment</h2>
                            {data?.env && <StatusBadge status={data.env.status} />}
                        </div>
                        <pre className="bg-gray-100 dark:bg-zinc-900 p-4 rounded text-xs overflow-auto">
                            {JSON.stringify(data?.env?.details, null, 2)}
                        </pre>
                    </div>
                </div>
            </div>
        </div>
    );
}
