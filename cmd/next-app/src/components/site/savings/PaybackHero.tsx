import type { RoiSummary } from '@/lib/roi/roi-service';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function PaybackHero({ summary }: { summary: RoiSummary }) {
    const combined = summary.components.find(c => c.kind === 'combined') ?? summary.components[0];
    if (!combined) return null;
    return (
        <div className="rounded-xl border border-gray-200 dark:border-slate-800 bg-bg-base p-5">
            <div className="text-xs uppercase opacity-60">System payback</div>
            <div className="text-3xl font-extrabold">{pct(combined.pctRecovered)} recovered</div>
            <div className="text-sm opacity-80 mt-1">
                {usd(combined.savedToDate)} saved of {usd(combined.cost)}
                {combined.breakEvenDate && ` · break-even ~ ${combined.breakEvenDate}`}
            </div>
            <div className="h-3 rounded-full bg-bg-muted mt-3 overflow-hidden">
                <div className="h-full bg-primary" style={{ width: pct(Math.min(1, combined.pctRecovered)) }} />
            </div>
            {summary.lowConfidence && (
                <p className="text-xs opacity-70 mt-2">⚠ Under a year of data — the projected break-even is a rough estimate.</p>
            )}
        </div>
    );
}
