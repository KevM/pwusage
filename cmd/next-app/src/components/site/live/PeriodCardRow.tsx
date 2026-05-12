import Link from 'next/link';
import type { UsageData } from '@/lib/energy-repo';
import { computeMarginalCost } from '@/lib/marginal-cost';
import { periodKey, type CheaperPeriod } from '@/lib/next-cheaper-period';
import { formatTouName, formatCentsPerKwh } from '@/lib/format-utils';
import { PeriodCard } from './PeriodCard';

export interface ActivePeriod {
    name: string;
    buyRate: number;
    sellRate: number;
}

export interface PeriodCardRowProps {
    siteId: string;
    cycle: UsageData[];
    activePeriod: ActivePeriod | null;
    hasTariff: boolean;
    nextCheaper?: CheaperPeriod | null;
    nextCheaperPhrase?: string | null;
    nextStartPhraseByKey?: Record<string, string>;
    activeIsCheapest?: boolean;
}

function NextCheaperBanner({
    nextCheaper, nextCheaperPhrase, hasActive, activeIsCheapest
}: {
    nextCheaper: CheaperPeriod | null | undefined;
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

export function PeriodCardRow({ siteId, cycle, activePeriod, hasTariff, nextCheaper, nextCheaperPhrase, nextStartPhraseByKey, activeIsCheapest = false }: PeriodCardRowProps) {
    if (!hasTariff) {
        return (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-300">
                Configure a tariff to see load-timing recommendations.{' '}
                <Link href={`/site/${siteId}/settings`} className="underline">Open site settings →</Link>
            </div>
        );
    }

    if (cycle.length === 0) {
        return (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-300">
                No cycle data yet — recommendations will appear once the site reports usage.
            </div>
        );
    }

    return (
        <>
            <NextCheaperBanner
                nextCheaper={nextCheaper}
                nextCheaperPhrase={nextCheaperPhrase}
                hasActive={activePeriod !== null}
                activeIsCheapest={activeIsCheapest}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {cycle.map((usage) => {
                    const { cycleNetExportKwh, marginalCost, basis } = computeMarginalCost(usage);
                    const name = usage.touName ?? 'Unknown';
                    // Match active card on name + rates so same-name schedules across
                    // seasons (which differ by rate) don't both light up.
                    const isActive = activePeriod !== null
                        && name === activePeriod.name
                        && (usage.buyRate ?? 0) === activePeriod.buyRate
                        && (usage.sellRate ?? 0) === activePeriod.sellRate;
                    const key = periodKey(name, usage.buyRate ?? 0, usage.sellRate ?? 0);
                    const nextStartPhrase = isActive ? null : (nextStartPhraseByKey?.[key] ?? null);
                    return (
                        <PeriodCard
                            key={`${usage.tariff.id}|${name}|${usage.buyRate ?? 0}|${usage.sellRate ?? 0}`}
                            name={name}
                            cycleNetExportKwh={cycleNetExportKwh}
                            marginalCost={marginalCost}
                            basis={basis}
                            isActive={isActive}
                            nextStartPhrase={nextStartPhrase}
                        />
                    );
                })}
            </div>
        </>
    );
}
