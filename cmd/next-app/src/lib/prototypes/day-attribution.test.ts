import { describe, expect, it } from 'vitest';
import type { EnergyData, Tariff, TariffSchedule } from '../db-types';
import { addDaysInSiteTimezone, parseSiteLocalDateToMidnight } from '../date-utils';
import { Schedule } from '../schedule';
import { decodeDaySamples, encodeDaySamples, rollupDay, toSample, type EnergySample } from './compact-energy';
import {
    DAY_GAP_HEAL_DAYS, attributeSamples, currentTariffTimelineRevision, dayStatus, deriveDayAttribution,
    isAttributionComplete, rollupSamples, segmentsFromV1Rows, validateDayAttribution, type DayAttribution,
} from './day-attribution';

const tz = 'America/Chicago';
const SLOT = 300000;
const period = (id: number, from_hour: number | null, to_hour: number | null, extra: Partial<TariffSchedule> = {}): TariffSchedule => ({
    id, season_id: 10, name: `P${id}`, buy_rate: id / 100, sell_rate: 0.04,
    from_day_of_week: 0, to_day_of_week: 6, from_hour, from_minute: 0, to_hour, to_minute: 0, ...extra,
});
// Off-peak all day, on-peak 08:00-21:00 local (schedule 302 over 301).
const tariff = (schedules: TariffSchedule[]): Tariff => ({ id: 82, site_id: 'site', updated: new Date(0), name: 'Utility',
    seasons: [{ id: 10, tariff_id: 82, name: 'All year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.1, sell_rate: 0.04, schedules }] });
const touSchedule = new Schedule([tariff([period(301, null, null), period(302, 8, 21)])], tz);
const day = (date: string) => {
    const start = parseSiteLocalDateToMidnight(date, tz);
    return { start, end: addDaysInSiteTimezone(start, 1, tz) };
};
const sample = (timestamp: Date, i = 0): EnergySample => ({ site_id: 'site', timestamp,
    load_power: 10 + i * 0.1, solar_power: i % 7, grid_power: (i % 5) - 2.5, battery_power: (i % 3) - 1, battery_soc: i % 4 ? 50 + i / 10 : null });
const fullDay = (start: Date, end: Date) => Array.from({ length: (+end - +start) / SLOT }, (_, i) => sample(new Date(+start + i * SLOT), i));

describe('deriveDayAttribution', () => {
    it('run-length encodes a plain day priced at each sample label (interval start)', () => {
        const { start, end } = day('2026-10-14');
        expect(deriveDayAttribution(touSchedule, 82, start, end)).toEqual({
            timelineRevision: 'current-tariff:82',
            segments: [
                { offset: 0, tariffId: 82, scheduleId: 301 },
                { offset: 480, tariffId: 82, scheduleId: 302 },
                { offset: 1260, tariffId: 82, scheduleId: 301 },
            ],
        });
        expect(currentTariffTimelineRevision(82)).toBe('current-tariff:82');
    });
    it('does not shift labels: the 07:55 slot is off-peak and the 08:00 slot is on-peak', () => {
        const { start, end } = day('2026-10-14');
        const a = deriveDayAttribution(touSchedule, 82, start, end);
        const rows = attributeSamples([sample(new Date(+start + 475 * 60000)), sample(new Date(+start + 480 * 60000))], a, start, end);
        expect(rows.map(r => r.tariff_schedule_id)).toEqual([301, 302]);
    });
    it.each([['2026-03-08', 1380, 420], ['2026-11-01', 1500, 540]])('uses minutes from day_start on the DST day %s', (date, minutes, peak) => {
        const { start, end } = day(date);
        expect((+end - +start) / 60000).toBe(minutes);
        const a = deriveDayAttribution(touSchedule, 82, start, end);
        expect(a.segments.map(s => s.offset)).toEqual([0, peak, peak + 780]);
        expect(() => validateDayAttribution(a, start, end)).not.toThrow();
    });
    it('marks minutes with no matching period as null (no synthetic fallback)', () => {
        const { start, end } = day('2026-10-14');
        const partial = new Schedule([tariff([period(302, 8, 21)])], tz);
        const a = deriveDayAttribution(partial, 82, start, end);
        expect(a.segments).toEqual([
            { offset: 0, tariffId: 82, scheduleId: null },
            { offset: 480, tariffId: 82, scheduleId: 302 },
            { offset: 1260, tariffId: 82, scheduleId: null },
        ]);
        expect(isAttributionComplete(a)).toBe(false);
        expect(isAttributionComplete(deriveDayAttribution(touSchedule, 82, start, end))).toBe(true);
    });
    it('a boundary off the 5-minute grid takes effect at the next slot', () => {
        const { start, end } = day('2026-10-14');
        const odd = new Schedule([tariff([period(301, null, null), period(302, 8, 21, { from_minute: 7 })])], tz);
        expect(deriveDayAttribution(odd, 82, start, end).segments[1].offset).toBe(490);
    });
});

describe('validateDayAttribution', () => {
    const { start, end } = day('2026-10-14');
    const ok: DayAttribution = { timelineRevision: 'current-tariff:82', segments: [{ offset: 0, tariffId: 82, scheduleId: 301 }, { offset: 480, tariffId: 82, scheduleId: 302 }] };
    it('accepts a canonical timeline', () => expect(() => validateDayAttribution(ok, start, end)).not.toThrow());
    it.each([
        ['no segments', { ...ok, segments: [] }],
        ['not starting at 0', { ...ok, segments: [{ offset: 5, tariffId: 82, scheduleId: 301 }] }],
        ['unsorted', { ...ok, segments: [ok.segments[0], { offset: 480, tariffId: 82, scheduleId: 302 }, { offset: 240, tariffId: 82, scheduleId: 301 }] }],
        ['off the 5-minute grid', { ...ok, segments: [ok.segments[0], { offset: 481, tariffId: 82, scheduleId: 302 }] }],
        ['past day end', { ...ok, segments: [ok.segments[0], { offset: 1440, tariffId: 82, scheduleId: 302 }] }],
        ['adjacent duplicates', { ...ok, segments: [ok.segments[0], { offset: 480, tariffId: 82, scheduleId: 301 }] }],
        ['non-integer IDs', { ...ok, segments: [{ offset: 0, tariffId: 82.5, scheduleId: 301 }] }],
        ['empty revision', { ...ok, timelineRevision: '' }],
    ])('rejects %s', (_, a) => expect(() => validateDayAttribution(a as DayAttribution, start, end)).toThrow('Invalid day attribution'));
});

describe('samples x segments rollup', () => {
    it.each(['2026-10-14', '2026-03-08', '2026-11-01'])('equals the v1 rollup of the same per-sample IDs on %s', date => {
        const { start, end } = day(date);
        const a = deriveDayAttribution(touSchedule, 82, start, end);
        const samples = fullDay(start, end);
        const v1: EnergyData[] = samples.map(s => {
            const tp = touSchedule.getTariffPeriod(s.timestamp)!;
            return { ...s, tariff_id: tp.tariff.id, tariff_schedule_id: tp.schedule.id };
        });
        const decoded = decodeDaySamples(encodeDaySamples(samples, start, end, 'brotli'));
        expect(rollupSamples(decoded, a, start, end)).toEqual(rollupDay(v1, start));
    });
    it('rejects samples outside the attributed day', () => {
        const { start, end } = day('2026-10-14');
        const a = deriveDayAttribution(touSchedule, 82, start, end);
        expect(() => attributeSamples([sample(end)], a, start, end)).toThrow();
    });
});

describe('segmentsFromV1Rows', () => {
    const { start, end } = day('2026-11-01');
    const v1 = (samples: EnergySample[], ids: (s: EnergySample, i: number) => [number, number | null]): EnergyData[] =>
        samples.map((s, i) => { const [tariff_id, tariff_schedule_id] = ids(s, i); return { ...s, tariff_id, tariff_schedule_id }; });
    const roundTrip = (rows: EnergyData[]) => {
        const segments = segmentsFromV1Rows(rows, start, end);
        const a = { timelineRevision: 'v1-samples', segments };
        validateDayAttribution(a, start, end);
        const samples = rows.map(toSample);
        expect(rollupSamples(samples, a, start, end)).toEqual(rollupDay(rows, start));
        expect(attributeSamples(samples, a, start, end)).toEqual(rows);
        return segments;
    };
    it('preserves the attribution each sample was priced with, mid-day tariff version changes included', () => {
        const rows = v1(fullDay(start, end), (_, i) => i < 100 ? [82, 301] : i < 200 ? [82, 302] : i < 250 ? [83, null] : [83, 401]);
        expect(roundTrip(rows)).toEqual([
            { offset: 0, tariffId: 82, scheduleId: 301 }, { offset: 500, tariffId: 82, scheduleId: 302 },
            { offset: 1000, tariffId: 83, scheduleId: null }, { offset: 1250, tariffId: 83, scheduleId: 401 },
        ]);
    });
    it('fills gaps from agreeing neighbours, extends edge segments, and leaves disagreeing gaps null', () => {
        const all = v1(fullDay(start, end), (_, i) => i < 150 ? [82, 301] : [82, 302]);
        // Leading gap, an interior gap inside 301, a gap spanning the 301->302 change, trailing gap.
        const rows = all.filter((_, i) => i >= 10 && !(i >= 40 && i < 60) && !(i >= 140 && i < 160) && i < 290);
        expect(roundTrip(rows)).toEqual([
            { offset: 0, tariffId: 82, scheduleId: 301 },
            { offset: 700, tariffId: 82, scheduleId: null },
            { offset: 800, tariffId: 82, scheduleId: 302 },
        ]);
    });
    it('rejects an empty day and off-grid labels', () => {
        expect(() => segmentsFromV1Rows([], start, end)).toThrow();
        expect(() => segmentsFromV1Rows([{ ...sample(new Date(+start + 1000)), tariff_id: 82, tariff_schedule_id: 301 }], start, end)).toThrow();
    });
});

describe('dayStatus', () => {
    const { start, end } = day('2026-10-14');
    const h = 3600000;
    const at = (ms: number) => new Date(+end + ms);
    it('is open before the day ends, even with every slot present', () => {
        expect(dayStatus({ end, sampleCount: 288, expectedSlots: 288, now: new Date(+start + h) })).toBe('open');
        expect(dayStatus({ end, sampleCount: 288, expectedSlots: 288, now: at(-1) })).toBe('open');
    });
    it('is complete once ended with every slot', () => {
        expect(dayStatus({ end, sampleCount: 288, expectedSlots: 288, now: end })).toBe('complete');
        expect(dayStatus({ end, sampleCount: 288, expectedSlots: 288, now: at(400 * 24 * h) })).toBe('complete');
    });
    it('stays open while short and inside the gap-heal window, then becomes gapped', () => {
        const window = DAY_GAP_HEAL_DAYS * 24 * h;
        expect(dayStatus({ end, sampleCount: 287, expectedSlots: 288, now: end })).toBe('open');
        expect(dayStatus({ end, sampleCount: 287, expectedSlots: 288, now: at(window) })).toBe('open');
        expect(dayStatus({ end, sampleCount: 287, expectedSlots: 288, now: at(window + 1) })).toBe('gapped');
    });
    it('starts the gap-heal window when Tesla access came back, if that is later than the day end', () => {
        const window = DAY_GAP_HEAL_DAYS * 24 * h;
        const restored = at(20 * 24 * h);
        expect(dayStatus({ end, sampleCount: 287, expectedSlots: 288, now: new Date(+restored + window), reachableSince: restored })).toBe('open');
        expect(dayStatus({ end, sampleCount: 287, expectedSlots: 288, now: new Date(+restored + window + 1), reachableSince: restored })).toBe('gapped');
        expect(dayStatus({ end, sampleCount: 287, expectedSlots: 288, now: at(window + 1), reachableSince: at(-h) })).toBe('gapped');
    });
    it('matches the gap-heal window', async () => {
        expect(DAY_GAP_HEAL_DAYS).toBe((await import('../gap-heal')).GAP_HEAL_DAYS);
    });
    it('rejects impossible counts', () => {
        expect(() => dayStatus({ end, sampleCount: 289, expectedSlots: 288, now: end })).toThrow();
        expect(() => dayStatus({ end, sampleCount: -1, expectedSlots: 288, now: end })).toThrow();
    });
});
