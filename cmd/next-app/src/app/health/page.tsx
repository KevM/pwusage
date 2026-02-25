'use client';

import { useEffect, useState } from 'react';

import { ErrorPanel, LoadingPanel } from '@/components/ui/AsyncState';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusPill } from '@/components/ui/StatusPill';

import type { HealthChecks } from '../api/health/route';

type SchemaSummaryDetails = {
    sites: number;
    energyDataRows: number;
};

function isSchemaSummaryDetails(details: unknown): details is SchemaSummaryDetails {
    if (!details || typeof details !== 'object') {
        return false;
    }

    const candidate = details as Record<string, unknown>;
    return typeof candidate.sites === 'number' && typeof candidate.energyDataRows === 'number';
}

export default function HealthPage() {
    const [data, setData] = useState<HealthChecks | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const fetchHealth = async () => {
        setLoading(true);
        setError('');
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

    if (loading) {
        return (
            <PageShell maxWidth="lg">
                <LoadingPanel title="Running diagnostics..." />
            </PageShell>
        );
    }

    if (error) {
        return (
            <PageShell maxWidth="lg">
                <ErrorPanel title="Failed to load health check" message={error} />
            </PageShell>
        );
    }

    const schemaDetails = isSchemaSummaryDetails(data?.schema?.details) ? data.schema.details : null;

    return (
        <PageShell maxWidth="lg" className="space-y-6">
            <PageHeader
                title="System Health Check"
                actions={(
                    <Button onClick={fetchHealth} disabled={loading}>
                        Refresh
                    </Button>
                )}
            />

            <div className="grid gap-6">
                <SectionCard
                    title="Database"
                    action={data?.database ? <StatusPill status={data.database.status} /> : null}
                >
                    <p className="font-mono text-sm text-gray-600 dark:text-gray-400">
                        {data?.database?.message}
                    </p>
                </SectionCard>

                <SectionCard
                    title="Data Storage"
                    action={data?.schema ? <StatusPill status={data.schema.status} /> : null}
                >
                    <div className="space-y-3">
                        {schemaDetails ? (
                            <div className="grid grid-cols-1 gap-4 text-center sm:grid-cols-2">
                                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-zinc-700 dark:bg-zinc-700">
                                    <div className="text-2xl font-bold text-gray-900 dark:text-white">{schemaDetails.sites}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400">Sites</div>
                                </div>
                                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-zinc-700 dark:bg-zinc-700">
                                    <div className="text-2xl font-bold text-gray-900 dark:text-white">{schemaDetails.energyDataRows}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400">Data Rows</div>
                                </div>
                            </div>
                        ) : null}
                        {data?.schema?.message ? (
                            <p className="text-sm text-red-500">{data.schema.message}</p>
                        ) : null}
                    </div>
                </SectionCard>

                <SectionCard
                    title="Tesla API"
                    action={data?.tesla ? <StatusPill status={data.tesla.status} /> : null}
                >
                    <p className="mb-2 font-mono text-sm text-gray-600 dark:text-gray-400">
                        {data?.tesla?.message}
                    </p>
                    {data?.tesla?.products ? (
                        <ul className="list-inside list-disc text-sm text-gray-500 dark:text-gray-400">
                            {data.tesla.products.map((p) => (
                                <li key={p.id}>{p.site_name} (ID: {p.id})</li>
                            ))}
                        </ul>
                    ) : null}
                </SectionCard>

                <SectionCard
                    title="Environment"
                    action={data?.env ? <StatusPill status={data.env.status} /> : null}
                >
                    <pre className="overflow-auto rounded-lg bg-gray-100 p-4 text-xs dark:bg-zinc-900">
                        {JSON.stringify(data?.env?.details, null, 2)}
                    </pre>
                </SectionCard>
            </div>
        </PageShell>
    );
}
