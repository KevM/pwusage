import type { MarginalCostBasis } from './marginal-cost';
import { formatCentsPerKwh } from './format-utils';

export interface PeriodCardDisplayInput {
    cycleNetExportKwh: number;
    marginalCost: number | null;
    basis: MarginalCostBasis;
    isActive: boolean;
}

export interface PeriodCardDisplay {
    costLabel: string;
    netLabel: string;
    colorClass: string;
    ringClass: string;
}

export function getPeriodCardDisplay(input: PeriodCardDisplayInput): PeriodCardDisplay {
    const { cycleNetExportKwh, marginalCost, basis, isActive } = input;

    const costLabel = marginalCost === null ? '—' : formatCentsPerKwh(marginalCost);

    let netLabel: string;
    if (basis === 'neutral') {
        netLabel = '—';
    } else {
        // Smart Shift's bank words (docs/voice-and-terms.md): arrows alone
        // don't say whether a period is banked or owed clearly enough.
        const word = cycleNetExportKwh > 0 ? 'banked' : 'owed';
        netLabel = `${Math.round(Math.abs(cycleNetExportKwh))} kWh ${word}`;
    }

    const colorClass =
        basis === 'sell' ? 'text-green-700 dark:text-green-400' :
        basis === 'buy' ? 'text-red-700 dark:text-red-400' :
        'text-gray-500 dark:text-gray-400';

    const ringClass = isActive ? 'ring-2 ring-blue-500' : '';

    return { costLabel, netLabel, colorClass, ringClass };
}
