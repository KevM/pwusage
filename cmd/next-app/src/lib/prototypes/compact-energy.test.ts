import { describe, expect, it } from 'vitest';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { EnergyData } from '../db-types';
import { addDaysInSiteTimezone, parseSiteLocalDateToMidnight } from '../date-utils';
import { encodeDay, decodeDay, decodeDaySamples, encodeDaySamples, rollupDay, type ArchiveCodec, toSample, type EnergySample } from './compact-energy';

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

describe('compact energy format v2 (samples only)', () => {
    const v2 = (timestamp: Date, overrides: Partial<EnergySample> = {}): EnergySample => ({
        site_id: 'site', timestamp, load_power: 12.123456789012345, solar_power: 0, grid_power: -2.123456789012345,
        battery_power: 3, battery_soc: null, ...overrides,
    });
    const header = (archive: ReturnType<typeof encodeDaySamples>) => {
        const bytes = archive.codec === 'gzip' ? gunzipSync(archive.data) : brotliDecompressSync(archive.data);
        return { header: JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString('utf8')), bytes };
    };
    it.each(codecs)('round-trips samples, nullable SoC, holes and -0 with %s', codec => {
        const rows = [v2(start, { battery_soc: 0 }), v2(new Date(+start + 600000), { grid_power: -0, battery_soc: 73.123456789 }), v2(new Date(+start + 900000))];
        const archive = encodeDaySamples(rows, start, end, codec);
        expect(archive).toMatchObject({ axis: 'grid', expectedSlots: 288 });
        const decoded = decodeDaySamples(archive, { siteId: 'site', start, end });
        expect(decoded).toEqual(rows);
        expect(Object.is(decoded[1].grid_power, -0)).toBe(true);
    });
    it('writes header version 2 with exactly five Float64 columns per sample', () => {
        const rows = [v2(start), v2(new Date(+start + 300000))];
        const { header: h, bytes } = header(encodeDaySamples(rows, start, end, 'gzip'));
        expect(h).toMatchObject({ version: 2, site: 'site', start: +start, end: +end, axis: 'grid', positions: [0, 1] });
        expect(bytes.length).toBe(4 + bytes.readUInt32LE(0) + rows.length * 5 * 8);
    });
    it.each(['2026-03-08', '2026-11-01'])('preserves every slot across Chicago DST on %s', date => {
        const from = parseSiteLocalDateToMidnight(date, 'America/Chicago');
        const to = addDaysInSiteTimezone(from, 1, 'America/Chicago');
        const rows = Array.from({ length: (+to - +from) / 300000 }, (_, i) => v2(new Date(+from + i * 300000), { load_power: i }));
        const archive = encodeDaySamples(rows, from, to, 'brotli');
        expect(archive.expectedSlots).toBe(date.includes('03-08') ? 276 : 300);
        expect(decodeDaySamples(archive)).toEqual(rows);
    });
    it('keeps irregular timestamps on the offsets axis and supports an empty day', () => {
        const rows = [v2(new Date(+start + 123)), v2(new Date(+start + 300456))];
        const archive = encodeDaySamples(rows, start, end, 'gzip');
        expect(archive.axis).toBe('offsets');
        expect(decodeDaySamples(archive)).toEqual(rows);
        expect(decodeDaySamples(encodeDaySamples([], start, end, 'brotli'))).toEqual([]);
    });
    it('still reads v1 archives as samples, dropping only the per-sample tariff IDs', () => {
        const rows = [sample(start, { battery_soc: 40 }), sample(new Date(+start + 300000), { tariff_schedule_id: null })];
        expect(decodeDaySamples(encodeDay(rows, start, end, 'brotli'))).toEqual(rows.map(toSample));
    });
    it('keeps decodeDay v1-only so a v2 payload is never read as tariff-tagged rows', () => {
        expect(() => decodeDay(encodeDaySamples([v2(start)], start, end, 'gzip'))).toThrow('Invalid header');
    });
    it('rejects corrupt, mis-identified, nonfinite, duplicate, mixed-site and out-of-day input', () => {
        const archive = encodeDaySamples([v2(start)], start, end, 'gzip');
        expect(() => decodeDaySamples({ ...archive, sha256: 'wrong' })).toThrow();
        expect(() => decodeDaySamples(archive, { siteId: 'other', start, end })).toThrow('Archive identity mismatch');
        for (const rows of [
            [v2(start, { grid_power: NaN })], [v2(start, { battery_soc: Infinity })], [v2(start), v2(start)],
            [v2(start), v2(new Date(+start + 300000), { site_id: 'other' })], [v2(end)], [v2(new Date(+start - 1))],
        ]) expect(() => encodeDaySamples(rows, start, end, 'gzip')).toThrow();
    });
    it('is smaller than v1 for the same day', () => {
        const rows = Array.from({ length: 288 }, (_, i) => sample(new Date(+start + i * 300000), { load_power: i * 1.37, tariff_schedule_id: i < 100 ? 2 : 5 }));
        const samples = rows.map(toSample);
        expect(encodeDaySamples(samples, start, end, 'brotli').data.length).toBeLessThan(encodeDay(rows, start, end, 'brotli').data.length);
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
