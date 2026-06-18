import { describe, it, expect } from 'vitest';
import { pickFixedBaselineStructure } from './resolve-fixed-baseline';
import type { ComparisonStructure } from './comparison-tariff-repo';
import type { Tariff } from '../db';

// Build a one-season Tariff. `windows` (buy rates) become TariffSchedules; differing buy rates ⇒ TOU.
function makeStructTariff(over: {
    id?: number; effective_from?: string | null; windows: number[];
}): Tariff {
    const id = over.id ?? 1;
    return {
        id, site_id: 's1', updated: new Date('2026-01-01T00:00:00Z'), name: 'T',
        reporting_only: true, effective_from: over.effective_from ?? null,
        seasons: [{
            id, tariff_id: id, name: 'All Year',
            from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: over.windows[0], sell_rate: 0.05,
            schedules: over.windows.map((buy, i) => ({
                id: 100 + i, season_id: id, name: `W${i}`, buy_rate: buy, sell_rate: 0.05,
                from_day_of_week: 0, to_day_of_week: 6, from_hour: null, from_minute: 0, to_hour: null, to_minute: 0,
            })),
        }],
    } as Tariff;
}
const fixedStruct = (name: string, eff: string | null, buy: number, id = 1): ComparisonStructure =>
    ({ name, tariffs: [makeStructTariff({ id, effective_from: eff, windows: [buy] })] });
const touStruct = (name: string, eff: string | null): ComparisonStructure =>
    ({ name, tariffs: [makeStructTariff({ effective_from: eff, windows: [0.10, 0.40] })] });

describe('pickFixedBaselineStructure', () => {
    it('picks the latest Fixed plan by current effective_from', () => {
        const structures = [fixedStruct('Old', '2024-01-01', 0.16), fixedStruct('New', '2026-01-01', 0.19)];
        expect(pickFixedBaselineStructure(structures)?.name).toBe('New');
    });

    it('skips TOU plans and chooses the Fixed one', () => {
        const structures = [touStruct('EV', '2025-01-01'), fixedStruct('Flat', '2024-01-01', 0.20)];
        expect(pickFixedBaselineStructure(structures)?.name).toBe('Flat');
    });

    it('returns null when no plan is Fixed', () => {
        expect(pickFixedBaselineStructure([touStruct('EV', '2025-01-01')])).toBeNull();
        expect(pickFixedBaselineStructure([])).toBeNull();
    });

    it('returns the full version history (enables date-resolution)', () => {
        // newest version first, mirroring listComparisonStructures ordering
        const multi: ComparisonStructure = { name: 'Flat', tariffs: [
            makeStructTariff({ id: 2, effective_from: '2026-01-01', windows: [0.19] }),
            makeStructTariff({ id: 1, effective_from: '2024-01-01', windows: [0.16] }),
        ] };
        expect(pickFixedBaselineStructure([multi])?.tariffs).toHaveLength(2);
    });
});
