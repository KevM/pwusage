import { formatTouName } from '@/lib/format-utils';
import type { MarginalCostBasis } from '@/lib/marginal-cost';
import { getPeriodCardDisplay } from '@/lib/period-card-display';

export interface PeriodCardProps {
    name: string;
    cycleNetExportKwh: number;
    marginalCost: number | null;
    basis: MarginalCostBasis;
    isActive: boolean;
    nextStartPhrase?: string | null;
}

export function PeriodCard({ name, cycleNetExportKwh, marginalCost, basis, isActive, nextStartPhrase }: PeriodCardProps) {
    const { costLabel, netLabel, colorClass, ringClass } = getPeriodCardDisplay({
        cycleNetExportKwh, marginalCost, basis, isActive
    });

    return (
        <div className={`rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800 ${ringClass}`}>
            <p className="text-sm text-gray-500 dark:text-gray-400">{formatTouName(name)}</p>
            <p className={`text-2xl font-semibold ${colorClass}`}>{costLabel}</p>
            <p className={`text-sm ${colorClass}`}>{netLabel}</p>
            {isActive ? (
                <p className="mt-1 text-xs uppercase tracking-wide text-blue-600 dark:text-blue-400">Active now</p>
            ) : nextStartPhrase ? (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Next {nextStartPhrase}</p>
            ) : null}
        </div>
    );
}
