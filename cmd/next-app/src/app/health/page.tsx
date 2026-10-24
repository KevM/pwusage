'use client';

import { useEffect, useState } from 'react';

import { ErrorPanel, LoadingPanel } from '@/components/ui/AsyncState';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusPill } from '@/components/ui/StatusPill';

import type { HealthChecks } from '../api/health/route';

type HealthResponse = HealthChecks | { status: 'ok' | 'error' };

type SchemaSummaryDetails = {
    sites: number;
    energyDays: number;
};

function isSchemaSummaryDetails(details: unknown): details is SchemaSummaryDetails {
    if (!details || typeof details !== 'object') {
        return false;
    }

    const candidate = details as Record<string, unknown>;
    return typeof candidate.sites === 'number' && typeof candidate.energyDays === 'number';
}

export default function HealthPage() {
    const [data, setData] = useState<HealthResponse | null>(null);
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
        let cancelled = false;
        fetch('/api/health')
            .then((res) => res.json())
            .then((json) => {
                if (cancelled) return;
                setData(json);
                setError('');
                setLoading(false);
            })
            .catch((err: Error) => {
                if (cancelled) return;
                setError(err.message);
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
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

    const detailedData = (data && 'database' in data) ? (data as HealthChecks) : null;
    const publicStatus = (data && 'status' in data && typeof data.status === 'string') ? data.status : 'ok';
    const schemaDetails = isSchemaSummaryDetails(detailedData?.schema?.details) ? detailedData.schema.details : null;

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

            {!detailedData ? (
                <SectionCard
                    title="Overall Status"
                    action={<StatusPill status={publicStatus} />}
                >
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                        System status is currently <span className="font-semibold">{publicStatus}</span>. Detailed system diagnostics require administrator authentication.
                    </p>
                </SectionCard>
            ) : (
                <div className="grid gap-6">
                    <SectionCard
                        title="Database"
                        action={detailedData.database ? <StatusPill status={detailedData.database.status} /> : null}
                    >
                        <p className="font-mono text-sm text-gray-600 dark:text-gray-400">
                            {detailedData.database?.message}
                        </p>
                    </SectionCard>

                    <SectionCard
                        title="Data Storage"
                        action={detailedData.schema ? <StatusPill status={detailedData.schema.status} /> : null}
                    >
                        <div className="space-y-3">
                            {schemaDetails ? (
                                <div className="grid grid-cols-1 gap-4 text-center sm:grid-cols-2">
                                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-zinc-700 dark:bg-zinc-700">
                                        <div className="text-2xl font-bold text-gray-900 dark:text-white">{schemaDetails.sites}</div>
                                        <div className="text-xs text-gray-500 dark:text-gray-400">Sites</div>
                                    </div>
                                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-zinc-700 dark:bg-zinc-700">
                                        <div className="text-2xl font-bold text-gray-900 dark:text-white">{schemaDetails.energyDays}</div>
                                        <div className="text-xs text-gray-500 dark:text-gray-400">Stored Days</div>
                                    </div>
                                </div>
                            ) : null}
                            {detailedData.schema?.message ? (
                                <p className="text-sm text-red-500">{detailedData.schema.message}</p>
                            ) : null}
                        </div>
                    </SectionCard>

                    <SectionCard
                        title="Tesla API"
                        action={detailedData.tesla ? <StatusPill status={detailedData.tesla.status} /> : null}
                    >
                        <p className="mb-2 font-mono text-sm text-gray-600 dark:text-gray-400">
                            {detailedData.tesla?.message}
                        </p>
                        {detailedData.tesla?.products ? (
                            <ul className="list-inside list-disc text-sm text-gray-500 dark:text-gray-400">
                                {detailedData.tesla.products.map((p) => (
                                    <li key={p.id}>{p.site_name} (ID: {p.id})</li>
                                ))}
                            </ul>
                        ) : null}
                    </SectionCard>

                    <SectionCard
                        title="Environment"
                        action={detailedData.env ? <StatusPill status={detailedData.env.status} /> : null}
                    >
                        <pre className="overflow-auto rounded-lg bg-gray-100 p-4 text-xs dark:bg-zinc-900">
                            {JSON.stringify(detailedData.env?.details, null, 2)}
                        </pre>
                    </SectionCard>
                </div>
            )}
        </PageShell>
    );
}
