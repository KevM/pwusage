'use client';

import { useEffect, useState } from 'react';
import { fetchSiteLiveData, isValidSiteId, SiteLiveDataFetchError } from '@/lib/site-live-data-client';
import type { SiteLiveData, SiteLiveSparklinePoint } from '@/lib/site-live-data-client';
import { LiveMetricChip } from '@/components/ui/LiveMetricChip';
import { Spinner } from '@/components/ui/Spinner';
import { MiniSparkline } from '@/components/ui/MiniSparkline';
import { BatteryStatusGlyph } from '@/components/ui/BatteryStatusGlyph';

function LiveStatsShell({ children }: { children: React.ReactNode }) {
    return (
        <div className="inline-flex w-full md:w-auto flex-wrap items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-bg-muted/60 px-2.5 py-1.5 shadow-sm dark:border-slate-800 dark:bg-slate-900/70 md:justify-start">
            {children}
        </div>
    );
}

function LiveStateIndicator({
    tone,
    label
}: {
    tone: 'live' | 'loading' | 'error';
    label: string;
}) {
    const toneClass =
        tone === 'live'
            ? 'bg-green-500 dark:bg-green-400'
            : tone === 'loading'
                ? 'bg-blue-500 dark:bg-blue-400'
                : 'bg-red-500 dark:bg-red-400';

    return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-600 dark:bg-slate-800/80 dark:text-gray-300">
            <span className={`h-1.5 w-1.5 rounded-full ${toneClass}`} aria-hidden="true" />
            {label}
        </span>
    );
}

export function HeaderLiveStats({ siteId }: { siteId: string }) {
    const [stats, setStats] = useState<SiteLiveData | null>(null);
    const [loading, setLoading] = useState(isValidSiteId(siteId));

    useEffect(() => {
        if (!isValidSiteId(siteId)) return;

        let isMounted = true;
        let redirectedToLogin = false;
        const controller = new AbortController();

        async function fetchStats() {
            try {
                if (!isMounted) return;
                const data = await fetchSiteLiveData(siteId, controller.signal);
                if (!isMounted) return;

                setStats(data);
                setLoading(false);
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    return;
                }
                if (error instanceof SiteLiveDataFetchError && error.status === 401) {
                    if (!redirectedToLogin) {
                        redirectedToLogin = true;
                        console.warn('[HeaderLiveStats] Unauthorized. Redirecting to login...');
                        window.location.href = '/login';
                    }
                    return;
                }
                if (isMounted) {
                    // Network/transient failures should not crash client rendering.
                    console.warn('Failed to refresh header stats:', error);
                    setLoading(false);
                }
            }
        }

        // Initial fetch
        fetchStats();

        // Poll every 2 minutes
        const interval = setInterval(fetchStats, 120000);

        return () => {
            isMounted = false;
            controller.abort();
            clearInterval(interval);
        };
    }, [siteId]);

    if (loading) {
        return (
            <LiveStatsShell>
                <LiveStateIndicator tone="loading" label="Live" />
                <div className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <Spinner size="sm" className="text-blue-500 dark:text-blue-400" />
                    <span className="font-medium">Syncing…</span>
                </div>
            </LiveStatsShell>
        );
    }

    if (!stats) {
        return (
            <LiveStatsShell>
                <LiveStateIndicator tone="error" label="Live" />
                <span className="text-sm font-medium text-red-700 dark:text-red-300">
                    Status unavailable
                </span>
            </LiveStatsShell>
        );
    }

    const { solarPower, loadPower, batteryPower, gridPower, percentageCharged } = stats;

    // Helper to format power (W to kW)
    const fmtKw = (w: number) => (Math.abs(w) / 1000).toFixed(1);

    const batteryValueClassName =
        batteryPower < -100
            ? 'inline-flex items-center leading-none text-green-700 dark:text-green-300'
            : batteryPower > 100
                ? 'inline-flex items-center leading-none text-red-700 dark:text-red-300'
                : 'inline-flex items-center leading-none text-purple-700 dark:text-purple-300';

    const gridValueClassName =
        gridPower > 100
            ? 'text-orange-700 dark:text-orange-300'
            : gridPower < -100
                ? 'text-green-700 dark:text-green-300'
                : 'text-gray-700 dark:text-gray-300';

    const toSparklinePoints = (points?: SiteLiveSparklinePoint[]) =>
        (points ?? []).map((point) => ({ watts: point.watts }));

    const solarSparkline = toSparklinePoints(stats.sparklines?.solar);
    const gridSparkline = toSparklinePoints(stats.sparklines?.grid);
    const loadSparkline = toSparklinePoints(stats.sparklines?.load);
    const solarScale = stats.sparklineScales?.solar;
    const gridScale = stats.sparklineScales?.grid;
    const loadScale = stats.sparklineScales?.load;

    const batteryGlyph = (
        <span className="inline-flex items-center self-center leading-none">
            <BatteryStatusGlyph
                percentage={percentageCharged}
                powerWatts={batteryPower}
                className="block h-3.5 w-[1.55rem]"
            />
        </span>
    );

    return (
        <LiveStatsShell>
            <LiveStateIndicator tone="live" label="Live" />
            <LiveMetricChip
                label="Battery"
                value={batteryGlyph}
                labelStyle="text"
                surfaceStyle="flat"
                valueClassName={batteryValueClassName}
                title={`Battery (${Math.round(percentageCharged)}%)`}
            />
            <LiveMetricChip
                label="Solar"
                value={`${fmtKw(solarPower)} kW`}
                labelStyle="text"
                surfaceStyle="flat"
                valueClassName="text-amber-700 dark:text-amber-300"
                title="Solar Production"
                trailing={(
                    <MiniSparkline
                        series={solarSparkline}
                        yMin={solarScale?.minWatts}
                        yMax={solarScale?.maxWatts}
                        className="h-3 w-8"
                        strokeClassName="text-amber-600 dark:text-amber-300"
                    />
                )}
            />
            <LiveMetricChip
                label="Grid"
                value={`${fmtKw(Math.abs(gridPower))} kW`}
                labelStyle="text"
                surfaceStyle="flat"
                valueClassName={gridValueClassName}
                title="Grid Usage"
                trailing={(
                    <MiniSparkline
                        series={gridSparkline}
                        includeZero
                        yMin={gridScale?.minWatts}
                        yMax={gridScale?.maxWatts}
                        className="h-3 w-8"
                        strokeClassName={gridPower > 100
                            ? 'text-orange-600 dark:text-orange-300'
                            : gridPower < -100
                                ? 'text-green-600 dark:text-green-300'
                                : 'text-gray-500 dark:text-gray-400'}
                    />
                )}
            />
            <LiveMetricChip
                label="Load"
                value={`${fmtKw(loadPower)} kW`}
                labelStyle="text"
                surfaceStyle="flat"
                valueClassName="text-blue-700 dark:text-blue-300"
                title="Home Usage"
                trailing={(
                    <MiniSparkline
                        series={loadSparkline}
                        yMin={loadScale?.minWatts}
                        yMax={loadScale?.maxWatts}
                        className="h-3 w-8"
                        strokeClassName="text-blue-600 dark:text-blue-300"
                    />
                )}
            />
        </LiveStatsShell>
    );
}
