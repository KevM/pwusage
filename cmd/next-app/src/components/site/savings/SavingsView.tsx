import type { RoiSummary } from '@/lib/roi/roi-service';
import type { RollupBackfill, SiteRoiConfig } from '@/lib/db';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';
import { PaybackHero } from './PaybackHero';
import { ExtendedGrid } from './ExtendedGrid';
import type { ExtendedGridModel } from '@/lib/roi/extended-grid';
import { IndexingStatus } from './IndexingStatus';
import { SavingsSettings } from './SavingsSettings';
import { selectSavingsViewState } from '@/lib/roi/savings-status';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function SavingsView({
    summary,
    arbitrageSlot,
    chartSlot,
    siteId,
    backfill,
    roiConfig,
    comparisonPlans,
    extendedGrid,
    meteredPlanName,
}: {
    summary: RoiSummary | null;
    arbitrageSlot?: React.ReactNode;
    chartSlot?: React.ReactNode;
    siteId: string;
    backfill: RollupBackfill | null;
    roiConfig: SiteRoiConfig | null;
    comparisonPlans: ComparisonPlan[];
    extendedGrid: ExtendedGridModel | null;
    meteredPlanName?: string;
}) {
    const state = selectSavingsViewState(summary, backfill);
    const settings = (defaultOpen: boolean) => (
        <SavingsSettings
            siteId={siteId}
            roiConfig={roiConfig}
            comparisonPlans={comparisonPlans}
            meteredPlanName={meteredPlanName ?? 'Standard'}
            defaultOpen={defaultOpen}
        />
    );

    // In-process backfill (pending | running | error): show progress and settings.
    if (state === 'in-process') {
        return (
            <div className="space-y-6 max-w-5xl mx-auto">
                <IndexingStatus siteId={siteId} backfill={backfill} />
                {settings(false)}
            </div>
        );
    }

    // Not configured: lead with config; offer to index history only if never started.
    if (state === 'setup') {
        return (
            <div className="space-y-6 max-w-5xl mx-auto">
                {settings(true)}
                {!backfill && <IndexingStatus siteId={siteId} backfill={backfill} />}
            </div>
        );
    }

    // Configured: savings output first, settings tucked away at the bottom.
    const showBackfillPrompt = !backfill || backfill.status !== 'complete';
    return (
        <div className="space-y-6 max-w-5xl mx-auto">
            {showBackfillPrompt && <IndexingStatus siteId={siteId} backfill={backfill} />}
            <PaybackHero summary={summary!} />
            {summary!.recommendation && (
                <div className="rounded-lg border border-green-600 bg-green-600/10 dark:border-green-500 dark:bg-green-950/20 p-3 text-sm">
                    💡 You&apos;re on TOU, but a flat plan looks ~{usd(summary!.recommendation.annualSaving)}/yr cheaper for your usage.
                    <span className="opacity-70"> (Estimate holds your behavior fixed; the real flat saving is likely a bit larger.)</span>
                </div>
            )}
            {extendedGrid && <ExtendedGrid grid={extendedGrid} />}
            {summary!.actualPlan === 'fixed' && (
                <div className="rounded-lg border border-gray-200 dark:border-slate-800 bg-bg-muted/30 p-3 text-xs text-foreground/80 text-center">
                    ℹ️ You are on a fixed-rate plan. Add comparison plans in settings to see more columns; custom TOU comparison plans are coming soon.
                </div>
            )}
            {chartSlot}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {summary!.components.filter(c => c.kind !== 'combined').map(c => (
                    <div key={c.kind} className="rounded-lg border border-gray-200 dark:border-slate-800 p-4 bg-bg-base">
                        <div className="font-semibold capitalize">{c.kind === 'solar' ? '☀️ Solar' : '🔋 Battery'}</div>
                        <div className="h-2 rounded-full bg-bg-muted my-2 overflow-hidden">
                            <div className="h-full bg-primary" style={{ width: `${Math.round(Math.min(1, c.pctRecovered) * 100)}%` }} />
                        </div>
                        <div className="text-xs opacity-80">{usd(c.savedToDate)} / {usd(c.cost)}{c.breakEvenDate && ` · ${c.breakEvenDate.slice(0, 4)}`}</div>
                    </div>
                ))}
            </div>
            {arbitrageSlot}
            {settings(false)}
        </div>
    );
}
