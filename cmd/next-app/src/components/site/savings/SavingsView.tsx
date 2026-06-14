import type { RoiSummary } from '@/lib/roi/roi-service';
import { PaybackHero } from './PaybackHero';
import { ScenarioMatrix } from './ScenarioMatrix';
import { SavingsEmptyState } from './SavingsEmptyState';
import { IndexingStatus } from './IndexingStatus';
import type { RollupBackfill } from '@/lib/db';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function SavingsView({
    summary,
    arbitrageSlot,
    chartSlot,
    siteId,
    backfill,
    fixedPlanName,
    meteredPlanName,
}: {
    summary: RoiSummary | null;
    arbitrageSlot?: React.ReactNode;
    chartSlot?: React.ReactNode;
    siteId: string;
    backfill: RollupBackfill | null;
    fixedPlanName?: string;
    meteredPlanName?: string;
}) {
    const indexing = backfill?.status === 'pending' || backfill?.status === 'running';
    const showBackfillPrompt = !backfill || backfill.status !== 'complete';

    if (!summary) {
        return (
            <div className="space-y-6 max-w-5xl mx-auto">
                <IndexingStatus siteId={siteId} backfill={backfill} />
                {!backfill && <SavingsEmptyState />}
            </div>
        );
    }
    if (indexing) {
        return (
            <div className="space-y-6 max-w-5xl mx-auto">
                <IndexingStatus siteId={siteId} backfill={backfill} />
            </div>
        );
    }
    return (
        <div className="space-y-6 max-w-5xl mx-auto">
            {showBackfillPrompt && <IndexingStatus siteId={siteId} backfill={backfill} />}
            <PaybackHero summary={summary} />
            {summary.recommendation && (
                <div className="rounded-lg border border-green-600 bg-green-600/10 dark:border-green-500 dark:bg-green-950/20 p-3 text-sm">
                    💡 You&apos;re on TOU, but a flat plan looks ~{usd(summary.recommendation.annualSaving)}/yr cheaper for your usage.
                    <span className="opacity-70"> (Estimate holds your behavior fixed; the real flat saving is likely a bit larger.)</span>
                </div>
            )}
            <ScenarioMatrix summary={summary} fixedPlanName={fixedPlanName} meteredPlanName={meteredPlanName} />
            {summary.actualPlan === 'fixed' && (
                <div className="rounded-lg border border-gray-200 dark:border-slate-800 bg-bg-muted/30 p-3 text-xs text-foreground/80 text-center">
                    ℹ️ You are on a fixed-rate plan. TOU comparison columns use your current flat rates (defining a custom TOU comparison plan is coming soon).
                </div>
            )}
            {chartSlot}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {summary.components.filter(c => c.kind !== 'combined').map(c => (
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
        </div>
    );
}
