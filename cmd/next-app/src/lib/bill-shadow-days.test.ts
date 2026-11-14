import { describe, expect, it } from 'vitest';
import { compareShadowDays, summarizeShadowDays, type ShadowDay } from './bill-shadow-days';

const zone = 'America/Chicago';

describe('summarizeShadowDays', () => {
    it('totals grid energy per site-local day and keeps the last sample time', () => {
        const days = summarizeShadowDays([
            { timestamp: new Date('2026-11-13T05:55:00Z'), grid_power: 4 },
            { timestamp: new Date('2026-11-14T06:00:00Z'), grid_power: 10 },
            { timestamp: new Date('2026-11-14T06:05:00Z'), grid_power: -2.5 },
        ], zone);

        expect(days).toEqual([
            { day: '2026-11-12', gridWh: 4, last: '2026-11-13T05:55:00.000Z' },
            { day: '2026-11-14', gridWh: 7.5, last: '2026-11-14T06:05:00.000Z' },
        ]);
    });
});

describe('compareShadowDays', () => {
    const server: ShadowDay[] = [
        { day: '2026-11-13', gridWh: 3935, last: '2026-11-14T05:55:00.000Z' },
        { day: '2026-11-14', gridWh: 980, last: '2026-11-14T16:40:00.000Z' },
    ];

    it('lists only days whose totals or last sample differ', () => {
        const local: ShadowDay[] = [
            { day: '2026-11-13', gridWh: 3935.2, last: '2026-11-14T05:55:00.000Z' },
            { day: '2026-11-14', gridWh: 2.4, last: '2026-11-14T06:00:00.000Z' },
        ];

        expect(compareShadowDays(server, local)).toEqual([{
            day: '2026-11-14',
            serverGridWh: 980,
            localGridWh: 2.4,
            serverLast: '2026-11-14T16:40:00.000Z',
            localLast: '2026-11-14T06:00:00.000Z',
        }]);
    });

    it('reports a day present on one side only', () => {
        expect(compareShadowDays(server, [server[0]])).toEqual([{
            day: '2026-11-14',
            serverGridWh: 980,
            localGridWh: null,
            serverLast: '2026-11-14T16:40:00.000Z',
            localLast: null,
        }]);
    });
});
