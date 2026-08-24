import { describe, expect, it } from 'vitest';
import { activePeriodSurplusKwh, todayNetExportByPeriod } from './headroom-from-bins';
import type { EnergyData } from './db-types';
import type { UsageData } from './energy-repo';

const MIDNIGHT = new Date('2026-08-24T07:00:00Z');

function bin(minutesAfterMidnight: number, gridAvgWh: number): EnergyData {
    return {
        timestamp: new Date(MIDNIGHT.getTime() + minutesAfterMidnight * 60_000),
        site_id: 'site-1',
        tariff_id: 1,
        tariff_schedule_id: 1,
        load_power: 0,
        solar_power: 0,
        grid_power: gridAvgWh,
        battery_power: 0,
        battery_soc: null,
    };
}

// Minimal stand-in for Schedule: every timestamp maps to one TOU name.
function fakeSchedule(name: string) {
    return { getTariffPeriod: () => ({ schedule: { name } }) } as never;
}

describe('todayNetExportByPeriod', () => {
    it('converts bin averages to kWh, negating import into net export', () => {
        // Two bins exporting 1000 Wh each per 5-min sample => avg 1000, x3 per bin.
        const map = todayNetExportByPeriod(
            [bin(0, -1000), bin(15, -1000)],
            MIDNIGHT,
            fakeSchedule('OFF_PEAK')
        );
        // (1000 * 3 + 1000 * 3) / 1000 = 6 kWh exported
        expect(map.get('OFF_PEAK')).toBeCloseTo(6, 6);
    });

    it('treats import as negative net export', () => {
        const map = todayNetExportByPeriod([bin(0, 500)], MIDNIGHT, fakeSchedule('ON_PEAK'));
        expect(map.get('ON_PEAK')).toBeCloseTo(-1.5, 6);
    });

    it('ignores bins before site midnight', () => {
        const stale = bin(-60, -1000);
        const map = todayNetExportByPeriod([stale, bin(0, -1000)], MIDNIGHT, fakeSchedule('OFF_PEAK'));
        expect(map.get('OFF_PEAK')).toBeCloseTo(3, 6);
    });

    it('survives a gap in the data without inventing energy', () => {
        const map = todayNetExportByPeriod(
            [bin(0, -1000), bin(180, -1000)],
            MIDNIGHT,
            fakeSchedule('OFF_PEAK')
        );
        expect(map.get('OFF_PEAK')).toBeCloseTo(6, 6);
    });

    it('skips bins with no resolvable TOU period', () => {
        const noPeriod = { getTariffPeriod: () => null } as never;
        expect(todayNetExportByPeriod([bin(0, -1000)], MIDNIGHT, noPeriod).size).toBe(0);
    });

    it('uses row sample_count when present for boundary bins', () => {
        // Partial/boundary bins: 2 samples in schedule A, 1 sample in schedule B
        const binA = { ...bin(0, -1000), sample_count: 2 };
        const binB = { ...bin(0, -2000), sample_count: 1 };

        const map = todayNetExportByPeriod([binA, binB], MIDNIGHT, fakeSchedule('OFF_PEAK'));
        // binA: 1000 * 2 / 1000 = 2 kWh, binB: 2000 * 1 / 1000 = 2 kWh => total 4 kWh (not 6 + 6 = 12)
        expect(map.get('OFF_PEAK')).toBeCloseTo(4, 6);
    });

    it('returns an empty map for no bins', () => {
        expect(todayNetExportByPeriod([], MIDNIGHT, fakeSchedule('OFF_PEAK')).size).toBe(0);
    });
});

describe('activePeriodSurplusKwh', () => {
    const prior: UsageData[] = [
        {
            start: MIDNIGHT, homeUsage: 0, gridUsage: -40_000, solarProduction: 0,
            batteryChange: 0, tariff: { id: 1 } as never, touName: 'OFF_PEAK',
        },
        {
            start: MIDNIGHT, homeUsage: 0, gridUsage: 5_000, solarProduction: 0,
            batteryChange: 0, tariff: { id: 1 } as never, touName: 'ON_PEAK',
        },
    ];

    it('adds today onto the prior-day rollup for the active period', () => {
        const today = new Map([['OFF_PEAK', 6]]);
        // prior: -(-40000)/1000 = 40 kWh exported, plus 6 today
        expect(activePeriodSurplusKwh(prior, today, 'OFF_PEAK')).toBeCloseTo(46, 6);
    });

    it('returns a negative surplus when the period is in deficit', () => {
        expect(activePeriodSurplusKwh(prior, new Map(), 'ON_PEAK')).toBeCloseTo(-5, 6);
    });

    it('handles a period present only in today', () => {
        expect(activePeriodSurplusKwh(prior, new Map([['SHOULDER', 2]]), 'SHOULDER')).toBeCloseTo(2, 6);
    });

    it('returns zero for a period in neither source', () => {
        expect(activePeriodSurplusKwh(prior, new Map(), 'MYSTERY')).toBe(0);
    });
});
