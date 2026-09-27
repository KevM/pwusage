import { describe, expect, it } from 'vitest';
import type { Tariff } from './db-types';
import { Schedule } from './schedule';
import { buildLoadTimingTimeline } from './load-timing-timeline';

function makeSchedule(options: { switchHour?: number; switchMinute?: number; seasons?: Tariff['seasons'] } = {}): Schedule {
    const switchHour = options.switchHour ?? 12;
    const switchMinute = options.switchMinute ?? 30;
    const tariff: Tariff = {
        id: 1, site_id: 'site-a', name: 'Test', updated: new Date('2026-01-01'),
        seasons: options.seasons ?? [{
            id: 2, tariff_id: 1, name: 'All year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: 0.4, sell_rate: 0.05,
            schedules: [
                { id: 3, season_id: 2, name: 'Day', buy_rate: 0.4, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: switchHour, to_minute: switchMinute },
                { id: 4, season_id: 2, name: 'Night', buy_rate: 0.1, sell_rate: 0.02, from_day_of_week: 0, to_day_of_week: 6, from_hour: switchHour, from_minute: switchMinute, to_hour: 24, to_minute: 0 },
            ],
        }],
    };
    return new Schedule([tariff], 'America/Los_Angeles');
}

describe('buildLoadTimingTimeline', () => {
    it('merges adjacent minutes and preserves a non-hour tariff switch', () => {
        const now = new Date('2026-07-08T19:29:17Z'); // 12:29:17 in Los Angeles
        const timeline = buildLoadTimingTimeline(makeSchedule(), now, new Date('2026-07-08T19:32:00Z'));

        expect(timeline).toEqual([
            { start: '2026-07-08T19:29:17.000Z', end: '2026-07-08T19:30:00.000Z', periodKey: 'Day', name: 'Day', buyRate: 0.4, sellRate: 0.05 },
            { start: '2026-07-08T19:30:00.000Z', end: '2026-07-08T19:32:00.000Z', periodKey: 'Night', name: 'Night', buyRate: 0.1, sellRate: 0.02 },
        ]);
    });

    it('walks UTC minutes across the daylight-saving spring transition', () => {
        const schedule = makeSchedule({ switchHour: 3, switchMinute: 0 });
        const timeline = buildLoadTimingTimeline(schedule, new Date('2026-03-08T09:59:00Z'), new Date('2026-03-08T10:02:00Z'));

        expect(timeline.map(({ start, end, name }) => ({ start, end, name }))).toEqual([
            { start: '2026-03-08T09:59:00.000Z', end: '2026-03-08T10:00:00.000Z', name: 'Day' },
            { start: '2026-03-08T10:00:00.000Z', end: '2026-03-08T10:02:00.000Z', name: 'Night' },
        ]);
    });

    it('changes season identity and rates at a season boundary', () => {
        const seasons: NonNullable<Tariff['seasons']> = [
            { id: 2, tariff_id: 1, name: 'Summer', from_month: 6, from_day: 1, to_month: 9, to_day: 30, buy_rate: 0.4, sell_rate: 0.05,
                schedules: [{ id: 3, season_id: 2, name: 'Summer all day', buy_rate: 0.4, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }] },
            { id: 5, tariff_id: 1, name: 'Winter', from_month: 10, from_day: 1, to_month: 5, to_day: 31, buy_rate: 0.8, sell_rate: 0.02,
                schedules: [{ id: 6, season_id: 5, name: 'Winter all day', buy_rate: 0.8, sell_rate: 0.02, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }] },
        ];
        const timeline = buildLoadTimingTimeline(makeSchedule({ seasons }), new Date('2026-10-01T06:59:00Z'), new Date('2026-10-01T07:02:00Z'));

        expect(timeline.map(({ start, end, periodKey, name, buyRate, sellRate }) => ({ start, end, periodKey, name, buyRate, sellRate }))).toEqual([
            { start: '2026-10-01T06:59:00.000Z', end: '2026-10-01T07:00:00.000Z', periodKey: 'Summer all day', name: 'Summer all day', buyRate: 0.4, sellRate: 0.05 },
            { start: '2026-10-01T07:00:00.000Z', end: '2026-10-01T07:02:00.000Z', periodKey: 'Winter all day', name: 'Winter all day', buyRate: 0.8, sellRate: 0.02 },
        ]);
    });
});
