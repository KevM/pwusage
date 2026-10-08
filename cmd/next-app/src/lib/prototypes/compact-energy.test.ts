import { describe, expect, it } from 'vitest';
import type { EnergyData } from '../db-types';
import { addDaysInSiteTimezone, parseSiteLocalDateToMidnight } from '../date-utils';
import { encodeDay, decodeDay, rollupDay, type ArchiveCodec } from './compact-energy';

const codecs: ArchiveCodec[] = ['gzip', 'brotli'];
const sample = (timestamp: Date, overrides: Partial<EnergyData> = {}): EnergyData => ({
    site_id: 'site', timestamp, tariff_id: 1, tariff_schedule_id: 2,
    load_power: 12.123456789012345, solar_power: 0, grid_power: -2.123456789012345,
    battery_power: 3, battery_soc: null, ...overrides,
});
const start = new Date('2026-10-01T05:00:00Z');
const end = new Date('2026-10-02T05:00:00Z');

describe('compact energy prototype', () => {
    it.each(codecs)('preserves measurements, holes, nullable IDs and exact zero with %s', codec => {
        const rows = [sample(start), sample(new Date(+start + 600000), { tariff_id: 3, tariff_schedule_id: null, battery_soc: 73.123456789, grid_power: -0 })];
        const archive = encodeDay(rows, start, end, codec);
        expect(archive.axis).toBe('grid');
        expect(archive.expectedSlots).toBe(288);
        expect(decodeDay(archive)).toEqual(rows);
    });
    it.each(['2026-03-08', '2026-11-01'])('preserves every slot across Chicago DST on %s', date => {
        const from = parseSiteLocalDateToMidnight(date, 'America/Chicago');
        const to = addDaysInSiteTimezone(from, 1, 'America/Chicago');
        const rows = Array.from({ length: (+to - +from) / 300000 }, (_, i) => sample(new Date(+from + i * 300000)));
        const archive = encodeDay(rows, from, to, 'brotli');
        expect(archive.expectedSlots).toBe(date.includes('03-08') ? 276 : 300);
        expect(decodeDay(archive)).toEqual(rows);
    });
    it('preserves irregular millisecond timestamps without rounding', () => {
        const rows = [sample(new Date(+start + 123)), sample(new Date(+start + 300456))];
        const archive = encodeDay(rows, start, end, 'gzip');
        expect(archive.axis).toBe('offsets');
        expect(decodeDay(archive)).toEqual(rows);
    });
    it('feeds the same detailed analysis inputs after decoding', async () => {
        const { adaptTeslaData } = await import('../nilm/tesla-adapter');
        const rows = [sample(start), sample(new Date(+start + 300000), { battery_soc: 0, grid_power: 100 })];
        expect(adaptTeslaData(decodeDay(encodeDay(rows, start, end, 'brotli')))).toEqual(adaptTeslaData(rows));
    });
    it('supports an empty day without inventing zero-energy measurements', () => {
        const archive = encodeDay([], start, end, 'gzip');
        expect(decodeDay(archive)).toEqual([]);
        expect(rollupDay([], start)).toEqual([]);
    });
    it('rejects corrupt payloads and checksums', () => {
        const archive = encodeDay([sample(start)], start, end, 'gzip');
        expect(() => decodeDay({ ...archive, sha256: 'wrong' })).toThrow();
        expect(() => decodeDay({ ...archive, data: Buffer.from('broken') })).toThrow();
    });
    it('rejects nonfinite, duplicate, unsorted, mixed-site and out-of-day input', () => {
        for (const rows of [
            [sample(start, { grid_power: NaN })], [sample(start), sample(start)],
            [sample(new Date(+start + 300000)), sample(start)],
            [sample(start), sample(new Date(+start + 300000), { site_id: 'other' })],
            [sample(end)], [sample(new Date(+start - 1))],
        ]) expect(() => encodeDay(rows, start, end, 'gzip')).toThrow();
    });
    it('groups by historical tariff and schedule and keeps signed energy balances', () => {
        const rows = [sample(start, { grid_power: 20 }), sample(new Date(+start + 300000), { grid_power: -10 }),
            sample(new Date(+start + 600000), { tariff_id: 3, tariff_schedule_id: 4, grid_power: 5, battery_power: -2 })];
        const rollups = rollupDay(rows, start);
        expect(rollups).toHaveLength(2);
        expect(rollups[0]).toMatchObject({ tariff_id: 1, tariff_schedule_id: 2, grid_power: 10, sample_count: 2, sample_import_wh: 20, sample_export_wh: 10 });
        expect(rollups[1]).toMatchObject({ tariff_id: 3, tariff_schedule_id: 4, grid_power: 5, sample_discharge_wh: 2 });
        const recovered = decodeDay(encodeDay(rows, start, end, 'brotli'));
        expect(rollupDay(recovered, start)).toEqual(rollups);
    });
});

it('preserves web and TRMNL cycle billing across historical rate/version changes', async () => {
    const { EnergyRepo } = await import('../energy-repo');
    const { aggregateUsage } = await import('../tou-aggregation');
    const { Schedule } = await import('../schedule');
    const tariffs = [1, 3].map(id => ({ id, site_id: 'site', name: 'Utility', updated: start }));
    const schedules = [2, 4].map((id, index) => ({ id, season_id: id, name: 'ON_PEAK', buy_rate: index ? 0.31 : 0.30, sell_rate: 0.04,
        from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, to_hour: 24, from_minute: 0, to_minute: 0 }));
    const site = { id: 'site', timezone: 'America/Chicago', name: 'Test', installed: start, updated: start, billing_start_day: 11, json: null, tariffs };
    const schedule = new Schedule(tariffs, site.timezone);
    const first = [sample(start, { grid_power: -27471 })];
    const second = [sample(end, { tariff_id: 3, tariff_schedule_id: 4, grid_power: 10000 }),
        sample(new Date(+end + 300000), { tariff_id: 3, tariff_schedule_id: 4, grid_power: 8243 })];
    const reference = [...first.map(r => ({ ...r, day: start })), ...second.map(r => ({ ...r, day: end }))];
    const summaries = [...rollupDay(decodeDay(encodeDay(first, start, end, 'brotli')), start),
        ...rollupDay(decodeDay(encodeDay(second, end, new Date(+end + 86400000), 'brotli')), end)];
    const web = (priorAggregates: typeof reference | typeof summaries) => EnergyRepo.aggregateUsageByTOU({ siteId: site.id, start, priorAggregates, todayRaw: [], schedule,
        tariffMap: new Map(tariffs.map(t => [t.id, t])), scheduleMap: new Map(schedules.map(s => [s.id, s])) });
    expect(web(summaries)).toEqual(web(reference));
    expect(web(summaries).reduce((sum, r) => sum + (r.cost ?? 0), 0)).toBeCloseTo(-0.36912, 8);
    const trmnl = (prior: typeof reference | typeof summaries) => aggregateUsage(site, prior, [], schedule, tariffs, schedules);
    expect(trmnl(summaries)).toEqual(trmnl(reference));
});
