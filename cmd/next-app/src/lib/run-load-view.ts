import { costToRun, type LoadVerdict } from './load-affordance';
import { formatDollars, formatTouName } from './format-utils';
import type { LoadTimingPeriod } from './load-timing';

export interface RunLoadTile {
    name: string;
    costLabel: string;
    verdict: LoadVerdict;
    coveredKwh: number;
    boughtKwh: number;
    whenLabel: string;
    toneClass: string;
    barCoveredPct: number;
}

const TONE: Record<LoadVerdict, string> = {
    covered: 'text-green-700 dark:text-green-400',
    tight: 'text-amber-700 dark:text-amber-400',
    partial: 'text-amber-700 dark:text-amber-400',
    bought: 'text-red-700 dark:text-red-400',
};

/**
 * One tile per TOU period for the currently selected load size, active period
 * first so "what happens if I do it now" is the first thing read.
 *
 * `headroomKwh` is passed only when the user picked a preset; a custom slider
 * amount has no profile and therefore no margin to judge against.
 */
export function buildRunLoadTiles(
    periods: LoadTimingPeriod[],
    loadKwh: number,
    headroomKwh?: number
): RunLoadTile[] {
    const ordered = [...periods].sort((a, b) => Number(b.isActive) - Number(a.isActive));

    return ordered.map((p) => {
        const isUnresolvable = (p.buyRate === 0 && p.sellRate === 0) || p.marginalCost === null;

        if (isUnresolvable) {
            return {
                name: formatTouName(p.name),
                costLabel: '—',
                verdict: 'bought' as const,
                coveredKwh: 0,
                boughtKwh: loadKwh,
                whenLabel: p.isActive ? 'now' : (p.nextStartPhrase ?? ''),
                toneClass: 'text-gray-500 dark:text-gray-400',
                barCoveredPct: 0,
            };
        }

        const cost = costToRun(loadKwh, {
            surplusKwh: p.cycleNetExportKwh,
            buyRate: p.buyRate,
            sellRate: p.sellRate,
        }, headroomKwh);

        return {
            name: formatTouName(p.name),
            costLabel: formatDollars(cost.total),
            verdict: cost.verdict,
            coveredKwh: cost.coveredKwh,
            boughtKwh: cost.boughtKwh,
            whenLabel: p.isActive ? 'now' : (p.nextStartPhrase ?? ''),
            toneClass: TONE[cost.verdict],
            barCoveredPct: loadKwh > 0 ? (cost.coveredKwh / loadKwh) * 100 : 0,
        };
    });
}
