import { describe, expect, it } from 'vitest';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { EnergyData } from '../db-types';
import { addDaysInSiteTimezone, parseSiteLocalDateToMidnight } from '../date-utils';
import { decodeDaySamples, decodeDaySolar, encodeDaySamples, rollupDay, type ArchiveCodec, toSample, type EnergySample } from './compact-energy';

import { attributeSamples } from './day-attribution';

const codecs: ArchiveCodec[] = ['gzip', 'brotli'];
const sample = (timestamp: Date, overrides: Partial<EnergyData> = {}): EnergyData => ({
    site_id: 'site', timestamp, tariff_id: 1, tariff_schedule_id: 2,
    load_power: 12.123456789012345, solar_power: 0, grid_power: -2.123456789012345,
    battery_power: 3, battery_soc: null, ...overrides,
});
const start = new Date('2026-10-01T05:00:00Z');
const end = new Date('2026-10-02T05:00:00Z');

it('rejects a structurally valid legacy format-1 payload', () => {
    const header = Buffer.from(JSON.stringify({version:1,site:'site',start:+start,end:+end,axis:'grid',positions:[]}));
    const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
    const bytes = Buffer.concat([length,header]);
    expect(() => decodeDaySamples({codec:'gzip',axis:'grid',expectedSlots:288,
        sha256:createHash('sha256').update(bytes).digest('hex'),data:gzipSync(bytes)})).toThrow('Invalid header');
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
    it('decodes only the solar channel, equal to the solar field of a full decode', () => {
        const rows = [v2(start, { solar_power: 5.25 }), v2(new Date(+start + 300000), { solar_power: -0.04 }), v2(new Date(+start + 600000), { solar_power: 0 })];
        const archive = encodeDaySamples(rows, start, end, 'brotli');
        const identity = { siteId: 'site', start, end };
        expect(decodeDaySolar(archive, identity)).toEqual(decodeDaySamples(archive, identity).map(r => ({ timestamp: r.timestamp, solarWh: r.solar_power })));
        expect(decodeDaySolar(encodeDaySamples([], start, end, 'gzip'))).toEqual([]);
    });
    it('rejects a bad checksum, a mis-identified day and a nonfinite solar value when decoding solar only', () => {
        const archive = encodeDaySamples([v2(start, { solar_power: 4 })], start, end, 'gzip');
        expect(() => decodeDaySolar({ ...archive, sha256: 'wrong' })).toThrow('Invalid archive checksum');
        expect(() => decodeDaySolar(archive, { siteId: 'site', start, end: new Date(+end + 300000) })).toThrow('Archive identity mismatch');
        const bytes = gunzipSync(archive.data);
        bytes.writeDoubleLE(NaN, 4 + bytes.readUInt32LE(0) + 8);
        const tampered = { ...archive, sha256: createHash('sha256').update(bytes).digest('hex'), data: gzipSync(bytes) };
        expect(() => decodeDaySolar(tampered)).toThrow('Nonfinite sample');
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
    const roundTrip = (rows: EnergyData[], from: Date, until: Date) => attributeSamples(
        decodeDaySamples(encodeDaySamples(rows.map(toSample),from,until,'brotli')),
        {timelineRevision:'fixture',segments:[{offset:0,tariffId:rows[0].tariff_id,scheduleId:rows[0].tariff_schedule_id}]},from,until);
    const summaries = [...rollupDay(roundTrip(first,start,end),start),
        ...rollupDay(roundTrip(second,end,new Date(+end+86400000)),end)];
    const web = (priorAggregates: typeof reference | typeof summaries) => EnergyRepo.aggregateUsageByTOU({ siteId: site.id, start, priorAggregates, todayRaw: [], schedule,
        tariffMap: new Map(tariffs.map(t => [t.id, t])), scheduleMap: new Map(schedules.map(s => [s.id, s])) });
    expect(web(summaries)).toEqual(web(reference));
    expect(web(summaries).reduce((sum, r) => sum + (r.cost ?? 0), 0)).toBeCloseTo(-0.36912, 8);
    const trmnl = (prior: typeof reference | typeof summaries) => aggregateUsage(site, prior, [], schedule, tariffs, schedules);
    expect(trmnl(summaries)).toEqual(trmnl(reference));
});
