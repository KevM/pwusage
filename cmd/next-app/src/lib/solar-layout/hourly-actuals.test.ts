import { describe, expect, it } from 'vitest';
import { hourlySolarWh, solarActualsWindow } from './hourly-actuals';

const at = (iso: string, wh: number) => ({ timestamp: new Date(iso), solar_power: wh });

function hour(startIso: string, count: number, wh: number) {
    return Array.from({ length: count }, (_, i) => at(new Date(Date.parse(startIso) + i * 300_000).toISOString(), wh));
}

describe('hourlySolarWh', () => {
    it('rejects off-grid and conflicting samples without inventing energy', () => {
        const base = hour('2026-10-27T15:00:00Z', 11, 100);
        expect(hourlySolarWh([...base, at('2026-10-27T15:00:01Z', 100)])[0]).toMatchObject({ wh: 1100, complete: false });
        const conflict = at('2026-10-27T15:00:00Z', 200);
        for (const rows of [[...base, conflict], [conflict, ...base]])
            expect(hourlySolarWh(rows)[0]).toMatchObject({ wh: 1000, complete: false });
    });

    it('rejects invalid measurements and timestamps while accepting zero', () => {
        for (const value of [-1, NaN, Infinity]) {
            const rows = hour('2026-10-27T15:00:00Z', 12, 100);
            rows[0].solar_power = value;
            expect(hourlySolarWh(rows)[0]).toMatchObject({ wh: 1100, complete: false });
        }
        const rows = hour('2026-10-27T15:00:00Z', 12, 100);
        rows[0].solar_power = 0;
        expect(hourlySolarWh(rows)[0]).toMatchObject({ wh: 1100, complete: true });
        expect(() => hourlySolarWh([{ timestamp: new Date(NaN), solar_power: 1 }])).toThrow();
    });

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

    it('keeps the repeated fall-back local hour in distinct UTC buckets', () => {
        const out = hourlySolarWh([...hour('2026-11-01T06:00:00Z', 12, 10), ...hour('2026-11-01T07:00:00Z', 12, 20)]);
        expect(out.map(h => [h.hourStart, h.wh, h.complete])).toEqual([
            ['2026-11-01T06:00:00.000Z', 120, true], ['2026-11-01T07:00:00.000Z', 240, true],
        ]);
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
