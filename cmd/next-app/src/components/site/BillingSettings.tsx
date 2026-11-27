'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BillingStartDayForm } from '@/components/BillingStartDayForm';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import type { SiteTariffsTimelineResponse } from '@/lib/tariff-contract';
import { TariffList } from './TariffList';

export function BillingSettings({ siteId, billingDay, tariffTimeline }: {
    siteId: string;
    billingDay: number;
    tariffTimeline: SiteTariffsTimelineResponse | null;
}) {
    const router = useRouter();
    const [timelineOverride, setTimelineOverride] = useState<SiteTariffsTimelineResponse | null>(null);
    const timeline = timelineOverride ?? tariffTimeline;
    const [refreshLoading, setRefreshLoading] = useState(false);
    const [retryLoading, setRetryLoading] = useState(false);
    const [refreshStatus, setRefreshStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    useEffect(() => {
        const status = timeline?.reattribution?.status;
        if (status !== 'pending' && status !== 'running') return;
        const timer = setInterval(async () => {
            try {
                const res = await fetch(`/api/site/${siteId}/tariffs`, { credentials: 'include' });
                if (res.ok) {
                    const next = (await res.json()) as SiteTariffsTimelineResponse;
                    setTimelineOverride(next);
                }
            } catch {
                // Keep polling silently while re-attribution is active
            }
        }, 3000);
        return () => clearInterval(timer);
    }, [siteId, timeline?.reattribution?.status]);

    const handleRefreshTariffs = async () => {
        setRefreshLoading(true);
        setRefreshStatus(null);
        try {
            const response = await fetch(`/api/site/${siteId}/refresh-tariffs`, {
                method: 'POST',
                credentials: 'include'
            });
            const data = await response.json();

            if (!response.ok) {
                setRefreshStatus({
                    type: 'error',
                    message: data.error || 'Couldn’t refresh your rate plan. Try again.'
                });
                return;
            }

            if (data.timeline) {
                setTimelineOverride(data.timeline as SiteTariffsTimelineResponse);
            }
            setRefreshStatus({
                type: 'success',
                message: data.updatedFromTesla ? 'Rate plan updated' : 'Rate plan is up to date'
            });

            router.refresh();
        } catch (error) {
            setRefreshStatus({
                type: 'error',
                message: error instanceof Error ? error.message : 'An error occurred'
            });
        } finally {
            setRefreshLoading(false);
        }
    };

    const handleRetryReattribution = async () => {
        setRetryLoading(true);
        try {
            const response = await fetch(`/api/site/${siteId}/tariffs/reattribute`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (response.ok) {
                const data = (await response.json()) as SiteTariffsTimelineResponse;
                setTimelineOverride(data);
                router.refresh();
            }
        } finally {
            setRetryLoading(false);
        }
    };

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>Billing Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div>
                        <BillingStartDayForm siteId={siteId} initialDay={billingDay} />
                        <p className="text-xs text-gray-500 mt-1">
                            Calculates monthly usage starting from this day.
                        </p>
                    </div>
                </CardContent>
            </Card>

            <TariffList
                timeline={timeline}
                onRefresh={handleRefreshTariffs}
                refreshLoading={refreshLoading}
                refreshStatus={refreshStatus}
                onRetryReattribution={handleRetryReattribution}
                retryLoading={retryLoading}
                onTimelineUpdated={setTimelineOverride}
            />
        </div>
    );
}
