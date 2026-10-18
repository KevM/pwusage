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

    it('ends at a tariff gap past the required horizon instead of dropping the timeline', () => {
        // Summer covers June–September only, so October has no tariff.
        const seasons: NonNullable<Tariff['seasons']> = [
            { id: 2, tariff_id: 1, name: 'Summer', from_month: 6, from_day: 1, to_month: 9, to_day: 30, buy_rate: 0.4, sell_rate: 0.05,
                schedules: [{ id: 3, season_id: 2, name: 'Summer all day', buy_rate: 0.4, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }] },
        ];
        const schedule = makeSchedule({ seasons });
        const now = new Date('2026-09-20T07:00:00Z');

        const reaching = buildLoadTimingTimeline(schedule, now, new Date('2026-10-15T07:00:00Z'), new Date('2026-09-27T07:00:00Z'));
        const required = buildLoadTimingTimeline(schedule, now, new Date('2026-10-15T07:00:00Z'), new Date('2026-10-05T07:00:00Z'));

        expect(reaching.at(-1)?.end).toBe('2026-10-01T07:00:00.000Z');
        expect(required).toEqual([]);
    });

    it('lands quarter-hour and off-quarter switches on their minute', () => {
        const now = new Date('2026-07-08T18:00:00Z'); // 11:00 in Los Angeles
        const end = new Date('2026-07-09T18:00:00Z');

        const quarter = buildLoadTimingTimeline(makeSchedule({ switchMinute: 45 }), now, end);
        const offQuarter = buildLoadTimingTimeline(makeSchedule({ switchMinute: 10 }), now, end);

        expect(quarter.map(({ start, name }) => ({ start, name }))).toEqual([
            { start: '2026-07-08T18:00:00.000Z', name: 'Day' },
            { start: '2026-07-08T19:45:00.000Z', name: 'Night' },
            { start: '2026-07-09T07:00:00.000Z', name: 'Day' },
        ]);
        expect(offQuarter.map(({ start, name }) => ({ start, name }))).toEqual([
            { start: '2026-07-08T18:00:00.000Z', name: 'Day' },
            { start: '2026-07-08T19:10:00.000Z', name: 'Night' },
            { start: '2026-07-09T07:00:00.000Z', name: 'Day' },
        ]);
    });

    it('samples a 31-day horizon quickly', () => {
        const startedAt = performance.now();
        const timeline = buildLoadTimingTimeline(makeSchedule(), new Date('2026-10-18T05:00:00Z'), new Date('2026-11-18T06:00:00Z'));
        const elapsedMs = performance.now() - startedAt;

        expect(timeline.at(-1)?.end).toBe('2026-11-18T06:00:00.000Z');
        console.info(`[load-timing-timeline] 31-day timeline built in ${elapsedMs.toFixed(1)} ms`);
        expect(elapsedMs).toBeLessThan(50);
    });
});
