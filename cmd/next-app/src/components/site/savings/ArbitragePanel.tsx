// ArbitragePanel.tsx
import type { ArbitrageSummary } from '@/lib/roi/arbitrage-service';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function ArbitragePanel({ summary }: { summary: ArbitrageSummary }) {
    const solarPct = Math.round(summary.solarFraction * 100);
    return (
        <div className="rounded-xl border border-gray-200 dark:border-slate-800 bg-bg-base p-5">
            <div className="text-xs uppercase opacity-60">Estimated battery arbitrage</div>
            <div className="text-2xl font-bold">{summary.netPnl >= 0 ? '+' : ''}{usd(summary.netPnl)} net from battery trades</div>
            <div className="text-xs opacity-70 mb-3">Estimate — where your battery&apos;s value came from.</div>
            <div className="flex h-4 rounded-full overflow-hidden mb-2 bg-bg-muted">
                <div className="bg-yellow-500" style={{ width: `${solarPct}%` }} />
                <div className="bg-blue-500" style={{ width: `${100 - solarPct}%` }} />
            </div>
            <div className="text-xs opacity-80">{solarPct}% banked solar · {100 - solarPct}% cheap grid · {summary.dischargedKwh.toFixed(0)} kWh discharged</div>
            {summary.losingCycleCount > 0 && (
                <div className="mt-3 rounded-lg bg-red-500/10 border border-red-500/40 p-2 text-xs text-red-950 dark:text-red-200">
                    ⚠ {summary.losingCycleCount} losing cycle(s) detected — likely expensive grid charging (e.g. Storm Watch).
                </div>
            )}
        </div>
    );
}
