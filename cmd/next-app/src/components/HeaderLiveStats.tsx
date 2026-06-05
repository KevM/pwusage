'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { fetchSiteLiveData, isValidSiteId, SiteLiveDataFetchError } from '@/lib/site-live-data-client';
import type { SiteLiveData, SiteLiveSparklinePoint, SiteLiveSparklineScale } from '@/lib/site-live-data-client';
import { Spinner } from '@/components/ui/Spinner';
import { MiniSparkline } from '@/components/ui/MiniSparkline';
import { BatteryStatusGlyph } from '@/components/ui/BatteryStatusGlyph';
import { useVisiblePolling } from '@/lib/use-visible-polling';
import { buildHeaderMetricsModel } from '@/lib/header-metrics';
import type { HeaderMetricsModel } from '@/lib/header-metrics';
import type { BatteryActivity } from '@/lib/live-indicators';

function SolarIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className={className}
            aria-hidden="true"
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3v2.25m0 13.5V21M4.22 4.22l1.59 1.59m12.38 12.38l1.59 1.59M3 12h2.25m13.5 0H21M4.22 19.78l1.59-1.59m12.38-12.38l1.59-1.59M12 7.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9z"
            />
        </svg>
    );
}

function GridIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className={className}
            aria-hidden="true"
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
            />
        </svg>
    );
}

function LoadIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className={className}
            aria-hidden="true"
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"
            />
        </svg>
    );
}

function BatteryActivityGlyph({ status }: { status: Exclude<BatteryActivity, 'idle'> }) {
    if (status === 'charging') {
        return (
            <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 text-gray-700 dark:text-gray-300"
                aria-hidden="true"
                fill="currentColor"
            >
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" transform="rotate(-90 12 12)" />
            </svg>
        );
    }

    return (
        <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5 text-gray-700 dark:text-gray-300"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 2v10M3 12h18M7 16h10M10 20h4" transform="rotate(-90 12 12)" />
        </svg>
    );
}

function LiveStatsShell({
    children,
    href,
    isExpanded,
    setIsExpanded,
    shellRef
}: {
    children: React.ReactNode;
    href?: string;
    isExpanded: boolean;
    setIsExpanded: (v: boolean) => void;
    shellRef: React.RefObject<HTMLDivElement | null>;
}) {
    const router = useRouter();

    const handleClick = (e: React.MouseEvent) => {
        // On tablet and desktop (md: 768px+), navigate immediately
        if (window.innerWidth >= 768) {
            if (href) router.push(href);
            return;
        }

        if (!isExpanded) {
            e.preventDefault();
            e.stopPropagation();
            setIsExpanded(true);
        } else {
            // If already expanded, navigate
            if (href) router.push(href);
        }
    };

    const shellClass = isExpanded
        ? "absolute md:relative top-2 md:top-auto left-[48px] right-0 md:left-auto md:right-auto w-auto h-auto min-h-[40px] md:h-auto z-50 md:z-0 flex items-center justify-center gap-2 md:gap-3 rounded-lg border border-gray-200 bg-white dark:border-slate-800 dark:bg-slate-900 px-3 py-2 md:py-1.5 shadow-md md:shadow-sm md:border-gray-200 md:bg-bg-muted/60 dark:md:bg-slate-900/70 md:px-2.5 md:py-1.5 md:justify-start overflow-hidden transition-all duration-300 ease-in-out cursor-pointer group"
        : "relative md:relative h-[34px] flex items-center justify-center gap-2 md:gap-3 rounded-lg border border-transparent bg-gray-100/50 dark:bg-slate-800/40 px-2 py-1 shadow-sm md:border-gray-200 md:bg-bg-muted/60 dark:md:bg-slate-900/70 md:px-2.5 md:py-1.5 md:justify-start overflow-hidden transition-all duration-300 ease-in-out cursor-pointer hover:shadow-md group";

    const titleText = isExpanded
        ? "Click to view live detail page"
        : "Click to expand live metrics";

    return (
        <div
            ref={shellRef}
            onClick={handleClick}
            className={shellClass}
            title={titleText}
        >
            {children}
        </div>
    );
}

function LiveStateIndicator({
    tone,
    label,
    isExpanded
}: {
    tone: 'live' | 'loading' | 'error';
    label: string;
    isExpanded?: boolean;
}) {
    const toneClass =
        tone === 'live'
            ? 'bg-green-500 dark:bg-green-400'
            : tone === 'loading'
                ? 'bg-blue-500 dark:bg-blue-400'
                : 'bg-red-500 dark:bg-red-400';

    return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-1.5 py-0.5 sm:px-2 text-[11px] font-medium uppercase tracking-wide text-gray-600 dark:bg-slate-800/80 dark:text-gray-300 shrink-0">
            <span className={`h-1.5 w-1.5 rounded-full ${toneClass}`} aria-hidden="true" />
            <span className={isExpanded ? 'inline' : 'hidden sm:inline'}>{label}</span>
        </span>
    );
}

export interface HeaderMetricsStripProps {
    model: HeaderMetricsModel;
    solarSparkline: SiteLiveSparklinePoint[];
    gridSparkline: SiteLiveSparklinePoint[];
    loadSparkline: SiteLiveSparklinePoint[];
    solarScale?: SiteLiveSparklineScale;
    gridScale?: SiteLiveSparklineScale;
    loadScale?: SiteLiveSparklineScale;
    isExpanded?: boolean;
}

export function HeaderMetricsStrip({
    model,
    solarSparkline,
    gridSparkline,
    loadSparkline,
    solarScale,
    gridScale,
    loadScale,
    isExpanded = false
}: HeaderMetricsStripProps) {
    const batteryValueClassName =
        model.batteryPercentage >= 80
            ? 'text-green-500 dark:text-green-300'
            : model.batteryPercentage >= 60
                ? 'text-green-600 dark:text-green-400'
                : model.batteryPercentage >= 40
                    ? 'text-green-700 dark:text-green-500'
                    : model.batteryPercentage >= 20
                        ? 'text-green-800 dark:text-green-600'
                        : 'text-green-900 dark:text-green-700';

    return (
        <div className={`flex ${isExpanded ? 'flex-wrap justify-center lg:justify-start gap-y-1.5' : 'flex-nowrap'} items-center gap-x-2 md:gap-x-3 flex-1 min-w-0 group`}>
            <LiveStateIndicator tone="live" label="Live" isExpanded={isExpanded} />

            {/* Battery - hidden below sm, percentage hidden below md */}
            <div className={`${isExpanded ? 'inline-flex' : 'hidden sm:inline-flex'} items-center gap-1 shrink-0`}>
                <span className="inline-flex items-center gap-0.5 leading-none">
                    <BatteryStatusGlyph
                        percentage={model.batteryPercentage}
                        className="block h-3.5 w-[1.55rem]"
                    />
                    {model.batteryActivity !== 'idle' ? (
                        <BatteryActivityGlyph status={model.batteryActivity} />
                    ) : null}
                </span>
                <span className={`${isExpanded ? 'inline' : 'hidden md:inline'} text-xs font-semibold tabular-nums ${batteryValueClassName}`}>
                    {Math.round(model.batteryPercentage)}%
                </span>
            </div>

            {/* Solar */}
            <div className="flex items-center gap-0.5 md:gap-1 shrink-0">
                <span className="text-amber-500 dark:text-amber-400 shrink-0">
                    <SolarIcon />
                </span>
                <span className={`${isExpanded ? 'inline' : 'hidden md:inline'} text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mr-0.5`}>
                    Solar
                </span>
                <span className="text-sm font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                    {model.solarFormatted}
                </span>
                <span className={`${isExpanded ? 'inline-flex' : 'inline-flex max-md:hidden'} items-center ml-1 shrink-0`}>
                    <MiniSparkline
                        series={solarSparkline}
                        yMin={solarScale?.minWatts}
                        yMax={solarScale?.maxWatts}
                        className="h-3 w-8 shrink-0"
                        strokeClassName="text-amber-600 dark:text-amber-300"
                    />
                </span>
            </div>

            {/* Grid */}
            <div className="flex items-center gap-0.5 md:gap-1 shrink-0">
                <span className="text-gray-500 dark:text-gray-400 shrink-0">
                    <GridIcon />
                </span>
                <span className={`${isExpanded ? 'inline' : 'hidden md:inline'} text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mr-0.5`}>
                    Grid
                </span>
                <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100 flex items-center">
                    {model.gridFormatted}
                    {model.gridDirection !== 'none' && (
                        <span className="ml-0.5 font-sans font-bold text-xs" role="img" aria-label={model.gridDirection === 'import' ? 'Grid Import' : 'Grid Export'}>
                            <span aria-hidden="true">{model.gridDirection === 'import' ? '↓' : '↑'}</span>
                        </span>
                    )}
                </span>
                <span className={`${isExpanded ? 'inline-flex' : 'inline-flex max-md:hidden'} items-center ml-1 shrink-0`}>
                    <MiniSparkline
                        series={gridSparkline}
                        includeZero
                        yMin={gridScale?.minWatts}
                        yMax={gridScale?.maxWatts}
                        className="h-3 w-8 shrink-0"
                        strokeClassName="text-gray-900 dark:text-gray-100"
                        positiveStrokeClassName="text-gray-900 dark:text-gray-100"
                        negativeStrokeClassName="text-gray-400 dark:text-gray-500"
                    />
                </span>
            </div>

            {/* Load */}
            <div className="flex items-center gap-0.5 md:gap-1 shrink-0">
                <span className="text-blue-500 dark:text-blue-400 shrink-0">
                    <LoadIcon />
                </span>
                <span className={`${isExpanded ? 'inline' : 'hidden md:inline'} text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mr-0.5`}>
                    Load
                </span>
                <span className="text-sm font-semibold tabular-nums text-blue-700 dark:text-blue-300">
                    {model.loadFormatted}
                </span>
                <span className={`${isExpanded ? 'inline-flex' : 'inline-flex max-md:hidden'} items-center ml-1 shrink-0`}>
                    <MiniSparkline
                        series={loadSparkline}
                        yMin={loadScale?.minWatts}
                        yMax={loadScale?.maxWatts}
                        className="h-3 w-8 shrink-0"
                        strokeClassName="text-blue-600 dark:text-blue-300"
                    />
                </span>
            </div>

            {/* Shared unit */}
            <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400 shrink-0 select-none">
                kW
            </span>

            {/* View detail link affordance */}
            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 rounded-full border hover:bg-blue-100 dark:hover:bg-blue-900/70 hover:text-blue-700 dark:hover:text-blue-300 shrink-0 min-w-0 whitespace-nowrap transition-all duration-300 ease-in-out view-details-pill ${
                isExpanded 
                    ? 'opacity-100 w-24 px-2 border-blue-100 dark:border-blue-900/50 ml-1.5' 
                    : 'opacity-0 w-0 px-0 border-transparent ml-0 overflow-hidden max-md:hidden group-hover:opacity-100 group-hover:w-24 group-hover:px-2 group-hover:border-blue-100 dark:group-hover:border-blue-900/50 group-hover:ml-1.5'
            }`}>
                <span>View details</span>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
            </span>
        </div>
    );
}

export function HeaderLiveStats({ siteId }: { siteId: string }) {
    const [stats, setStats] = useState<SiteLiveData | null>(null);
    const [loading, setLoading] = useState(isValidSiteId(siteId));
    const [redirectedToLogin, setRedirectedToLogin] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const shellRef = useRef<HTMLDivElement | null>(null);

    // Document click listener to collapse on click outside
    useEffect(() => {
        if (!isExpanded) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (shellRef.current && !shellRef.current.contains(event.target as Node)) {
                setIsExpanded(false);
            }
        };

        const handleTouchOutside = (event: TouchEvent) => {
            if (shellRef.current && !shellRef.current.contains(event.target as Node)) {
                setIsExpanded(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('touchstart', handleTouchOutside);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('touchstart', handleTouchOutside);
        };
    }, [isExpanded]);

    useVisiblePolling(async () => {
        if (!isValidSiteId(siteId)) return;
        try {
            const data = await fetchSiteLiveData(siteId);
            setStats(data);
            setLoading(false);
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            if (error instanceof SiteLiveDataFetchError && error.status === 401) {
                if (!redirectedToLogin) {
                    setRedirectedToLogin(true);
                    console.warn('[HeaderLiveStats] Unauthorized. Redirecting to login...');
                    window.location.href = '/login';
                }
                return;
            }
            console.warn('Failed to refresh header stats:', error);
            setLoading(false);
        }
    }, 300000);

    const detailHref = isValidSiteId(siteId) ? `/site/${siteId}/live` : undefined;

    if (loading) {
        return (
            <LiveStatsShell href={detailHref} isExpanded={isExpanded} setIsExpanded={setIsExpanded} shellRef={shellRef}>
                <LiveStateIndicator tone="loading" label="Live" isExpanded={isExpanded} />
                <div className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 shrink-0">
                    <Spinner size="sm" className="text-blue-500 dark:text-blue-400" />
                    <span className="hidden sm:inline font-medium">Syncing…</span>
                </div>
            </LiveStatsShell>
        );
    }

    if (!stats) {
        return (
            <LiveStatsShell href={detailHref} isExpanded={isExpanded} setIsExpanded={setIsExpanded} shellRef={shellRef}>
                <LiveStateIndicator tone="error" label="Live" isExpanded={isExpanded} />
                <span className="text-xs sm:text-sm font-medium text-red-700 dark:text-red-300 shrink-0">
                    <span className="hidden sm:inline">Status </span>unavailable
                </span>
            </LiveStatsShell>
        );
    }

    const model = buildHeaderMetricsModel(stats);

    const solarSparkline = stats.sparklines?.solar ?? [];
    const gridSparkline = stats.sparklines?.grid ?? [];
    const loadSparkline = stats.sparklines?.load ?? [];
    const solarScale = stats.sparklineScales?.solar;
    const gridScale = stats.sparklineScales?.grid;
    const loadScale = stats.sparklineScales?.load;

    return (
        <LiveStatsShell href={detailHref} isExpanded={isExpanded} setIsExpanded={setIsExpanded} shellRef={shellRef}>
            <HeaderMetricsStrip
                model={model}
                solarSparkline={solarSparkline}
                gridSparkline={gridSparkline}
                loadSparkline={loadSparkline}
                solarScale={solarScale}
                gridScale={gridScale}
                loadScale={loadScale}
                isExpanded={isExpanded}
            />
        </LiveStatsShell>
    );
}
