import { describe, expect, it } from 'vitest';
import { buildRunLoadTiles } from './run-load-view';
import type { LoadTimingPeriod } from './load-timing';

const periods: LoadTimingPeriod[] = [
    {
        name: 'ON_PEAK', marginalCost: 0.12, basis: 'sell', cycleNetExportKwh: 10,
        isActive: true, nextStartPhrase: null, buyRate: 0.48, sellRate: 0.12,
    },
    {
        name: 'OFF_PEAK', marginalCost: 0.03, basis: 'sell', cycleNetExportKwh: 120,
        isActive: false, nextStartPhrase: 'in 2h 10m', buyRate: 0.15, sellRate: 0.03,
    },
];

describe('buildRunLoadTiles', () => {
    it('puts the active period first', () => {
        expect(buildRunLoadTiles(periods, 60)[0].name).toBe('On-Peak');
    });

    it('prices each period for the selected load', () => {
        const tiles = buildRunLoadTiles(periods, 60);
        expect(tiles[0].costLabel).toBe('$25.20');
        expect(tiles[1].costLabel).toBe('$1.80');
    });

    it('labels the active period as now and others by their start phrase', () => {
        const tiles = buildRunLoadTiles(periods, 60);
        expect(tiles[0].whenLabel).toBe('now');
        expect(tiles[1].whenLabel).toBe('in 2h 10m');
    });

    it('carries the verdict through to a tone class', () => {
        const tiles = buildRunLoadTiles(periods, 60);
        expect(tiles[0].verdict).toBe('partial');
        expect(tiles[0].toneClass).toContain('amber');
        expect(tiles[1].verdict).toBe('covered');
        expect(tiles[1].toneClass).toContain('green');
    });

    it('applies headroom so an affordable load can still read as tight', () => {
        const tiles = buildRunLoadTiles(periods, 60, 100);
        expect(tiles[1].verdict).toBe('covered'); // 120 >= 100
        const tighter = buildRunLoadTiles(periods, 60, 200);
        expect(tighter[1].verdict).toBe('tight'); // 120 < 200, still all sell-rate
        expect(tighter[1].costLabel).toBe('$1.80');
    });

    it('reports the covered share of the load as a bar percentage', () => {
        const tiles = buildRunLoadTiles(periods, 60);
        expect(tiles[0].barCoveredPct).toBeCloseTo(16.67, 1);
        expect(tiles[1].barCoveredPct).toBe(100);
    });

    it('falls back to an empty when-label if a period has no start phrase', () => {
        const orphan: LoadTimingPeriod[] = [{ ...periods[1], nextStartPhrase: null }];
        expect(buildRunLoadTiles(orphan, 5)[0].whenLabel).toBe('');
    });

    it('renders unresolvable periods with a dash cost label and grey tone class', () => {
        const unresolvable: LoadTimingPeriod[] = [{
            name: 'UNKNOWN_PERIOD', marginalCost: null, basis: 'buy', cycleNetExportKwh: 0,
            isActive: false, nextStartPhrase: null, buyRate: 0, sellRate: 0,
        }];
        const tile = buildRunLoadTiles(unresolvable, 10)[0];
        expect(tile.costLabel).toBe('—');
        expect(tile.verdict).toBe('unknown');
        expect(tile.toneClass).toContain('gray');
    });
});
