'use client';

import Link from 'next/link';
import type { LoadTimingView } from '@/lib/load-timing';
import { formatTouName, formatCentsPerKwh } from '@/lib/format-utils';
import { PeriodCard } from './PeriodCard';

export interface ActivePeriod {
    name: string;
    buyRate: number;
    sellRate: number;
}

export interface PeriodCardRowProps {
    siteId: string;
    hasTariff: boolean;
    loadTiming: LoadTimingView | null;
}

function NextCheaperBanner({
    nextCheaper, nextCheaperPhrase, hasActive, activeIsCheapest
}: {
    nextCheaper: { name: string; marginalCost: number } | null | undefined;
    nextCheaperPhrase: string | null | undefined;
    hasActive: boolean;
    activeIsCheapest: boolean;
}) {
    if (!hasActive) return null;

    if (nextCheaper && nextCheaperPhrase) {
        return (
            <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900 dark:border-green-900/60 dark:bg-green-950/40 dark:text-green-200">
                <span className="font-medium">Cheaper period starts {nextCheaperPhrase}</span>
                <span className="text-gray-700 dark:text-gray-300">
                    {' '}— {formatTouName(nextCheaper.name)} ({formatCentsPerKwh(nextCheaper.marginalCost)} marginal)
                </span>
            </div>
        );
    }

    // Only claim "cheapest right now" when active really is the cheapest by
    // marginal cost across the cycle. Otherwise stay silent — the per-card
    // "Next …" text on each card already conveys when cheaper periods occur.
    if (!activeIsCheapest) return null;

    return (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-gray-700 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-300">
            You&apos;re in the cheapest period right now.
        </div>
    );
}

export function PeriodCardRow({ siteId, hasTariff, loadTiming }: PeriodCardRowProps) {
    if (!hasTariff) {
        return (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-300">
                Configure a tariff to see load-timing recommendations.{' '}
                <Link href={`/site/${siteId}/settings`} className="underline">Open site settings →</Link>
            </div>
        );
    }

    if (!loadTiming || !loadTiming.hasCycleData || loadTiming.periods.length === 0) {
        return (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-300">
                No cycle data yet — recommendations will appear once the site reports usage.
            </div>
        );
    }

    const hasActive = loadTiming.periods.some(p => p.isActive);

    return (
        <>
            <NextCheaperBanner
                nextCheaper={loadTiming.nextCheaper}
                nextCheaperPhrase={loadTiming.nextCheaper?.phrase}
                hasActive={hasActive}
                activeIsCheapest={loadTiming.activeIsCheapest}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {loadTiming.periods.map((p) => {
                    return (
                        <PeriodCard
                            key={`${p.name}`}
                            name={p.name}
                            cycleNetExportKwh={p.cycleNetExportKwh}
                            marginalCost={p.marginalCost}
                            basis={p.basis}
                            isActive={p.isActive}
                            nextStartPhrase={p.nextStartPhrase}
                        />
                    );
                })}
            </div>
        </>
    );
}
