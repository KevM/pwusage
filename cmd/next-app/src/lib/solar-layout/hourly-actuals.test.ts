import { describe, expect, it } from 'vitest';
import { hourlySolarWh, solarActualsWindow } from './hourly-actuals';

const at = (iso: string, wh: number) => ({ timestamp: new Date(iso), solar_power: wh });

function hour(startIso: string, count: number, wh: number) {
    return Array.from({ length: count }, (_, i) => at(new Date(Date.parse(startIso) + i * 300_000).toISOString(), wh));
}

describe('hourlySolarWh', () => {
    it('sums a full hour of samples as complete', () => {
        expect(hourlySolarWh(hour('2026-10-27T15:00:00Z', 12, 100))).toEqual([{ hourStart: '2026-10-27T15:00:00.000Z', wh: 1200, complete: true }]);
    });

    it('marks an hour with a missing sample incomplete', () => {
        expect(hourlySolarWh(hour('2026-10-27T15:00:00Z', 11, 100))).toEqual([{ hourStart: '2026-10-27T15:00:00.000Z', wh: 1100, complete: false }]);
    });

    it('buckets by interval start, so 10:55 belongs to the 10:00 hour', () => {
        const out = hourlySolarWh([at('2026-10-27T10:55:00Z', 50), at('2026-10-27T11:00:00Z', 70)]);
        expect(out.map(h => [h.hourStart, h.wh])).toEqual([['2026-10-27T10:00:00.000Z', 50], ['2026-10-27T11:00:00.000Z', 70]]);
    });

    it('ignores duplicate samples', () => {
        const out = hourlySolarWh([...hour('2026-10-27T15:00:00Z', 12, 100), at('2026-10-27T15:05:00Z', 100)]);
        expect(out[0]).toEqual({ hourStart: '2026-10-27T15:00:00.000Z', wh: 1200, complete: true });
    });
});

describe('solarActualsWindow', () => {
    it('covers the 14 full local days before today plus today so far', () => {
        const now = new Date('2026-10-27T18:30:00Z');
        const { start, end } = solarActualsWindow(now, 'America/Chicago');
        expect(start.toISOString()).toBe('2026-10-13T05:00:00.000Z');
        expect(end).toEqual(now);
    });
});
