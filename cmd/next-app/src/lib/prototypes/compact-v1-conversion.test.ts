import { describe, expect, it } from 'vitest';
import type { EnergyData, Tariff, TariffSchedule } from '../db-types';
import { addDaysInSiteTimezone, parseSiteLocalDateToMidnight } from '../date-utils';
import { Schedule } from '../schedule';
import { decodeDaySamples, rollupDay, toSample } from './compact-energy';
import { recoverVerifiedSamples } from './compact-energy-recovery';
import { deriveDayAttribution } from './day-attribution';
import {
    CONVERSION_DAY_BYTES, ConversionUsageError, convertV1Day, parseConversionArgs, runV1Conversion, v1ConversionTimelineRevision,
    type ConversionCandidate, type V1ConversionRepo,
} from './compact-v1-conversion';
import type { DayConversionResult } from './compact-history-store';

const tz = 'America/Chicago';
const SLOT = 300000;
const revision = '00000000-0000-4000-8000-000000000001';
const createdAt = new Date('2026-10-20T12:00:00Z');
const day = (date: string) => {
    const start = parseSiteLocalDateToMidnight(date, tz);
    return { start, end: addDaysInSiteTimezone(start, 1, tz) };
};
const period = (id: number, from_hour: number | null, to_hour: number | null): TariffSchedule => ({
    id, season_id: 10, name: `P${id}`, buy_rate: id / 100, sell_rate: 0.04, from_day_of_week: 0, to_day_of_week: 6, from_hour, from_minute: 0, to_hour, to_minute: 0,
});
const tou = new Schedule([{ id: 82, site_id: 'site', updated: new Date(0), name: 'Utility',
    seasons: [{ id: 10, tariff_id: 82, name: 'All', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.1, sell_rate: 0.04,
        schedules: [period(301, null, null), period(302, 8, 21)] }] } as Tariff], tz);
/** v1 rows as the importer stored them: priced at each label with getTariffPeriod. */
const pricedRows = (start: Date, end: Date, keep: (i: number) => boolean = () => true): EnergyData[] =>
    Array.from({ length: (+end - +start) / SLOT }, (_, i) => i).filter(keep).map(i => {
        const timestamp = new Date(+start + i * SLOT);
        const p = tou.getTariffPeriod(timestamp)!;
        return { site_id: 'site', timestamp, tariff_id: Number(p.tariff.id), tariff_schedule_id: Number(p.schedule.id),
            load_power: 10 + i * 0.1, solar_power: i % 7, grid_power: (i % 5) - 2.5, battery_power: (i % 3) - 1, battery_soc: i % 4 ? 50 + i / 10 : null };
    });
const input = (start: Date, end: Date, rows: EnergyData[], extra: Partial<Parameters<typeof convertV1Day>[0]> = {}) => ({
    siteId: 'site', start, end, revision, createdAt, attributionComplete: rows.every(r => r.tariff_schedule_id !== null),
    rows, summaries: rollupDay(rows, start), now: new Date(+end + 30 * 86400000), ...extra,
});
const converted = (result: ReturnType<typeof convertV1Day>) => {
    if (!('day' in result)) throw new Error(`left v1: ${result.reason}`);
    return result.day;
};
/** The converted record read back the way recovery and readers verify it. */
const readBack = (start: Date, end: Date, d: ReturnType<typeof converted>) => recoverVerifiedSamples({
    site_id: 'site', day_start: start, day_end: end, revision, format_version: 2, codec: d.archive.codec, axis: d.archive.axis, checksum: d.archive.sha256,
    payload: d.archive.data, expected_slots: d.archive.expectedSlots, sample_count: d.metadata.sampleCount, attribution_complete: d.metadata.attributionComplete,
    first_timestamp: d.metadata.first, last_timestamp: d.metadata.last, max_interior_gap_ms: d.metadata.maxInteriorGapMs, metadata_checksum: d.metadata.checksum,
    metadata_version: 3, latest_metadata: d.latest.data, latest_checksum: d.latest.checksum, payload_checksum: d.payloadChecksum, raw_pruned: false,
    attribution: d.attribution, status: d.status, fetched_at: d.fetchedAt,
}, d.metadata.summaries);

describe('convertV1Day', () => {
    it('converts a full day: same samples, the attribution each sample was priced with, same summaries', () => {
        const { start, end } = day('2026-10-14');
        const rows = pricedRows(start, end);
        const d = converted(convertV1Day(input(start, end, rows)));
        expect(d.attribution).toEqual({ timelineRevision: 'v1-conversion:' + revision, segments: [
            { offset: 0, tariffId: 82, scheduleId: 301 }, { offset: 480, tariffId: 82, scheduleId: 302 }, { offset: 1260, tariffId: 82, scheduleId: 301 }] });
        // Interval-start labels: the converted timeline equals what a v2 write derives for the day.
        expect(d.attribution.segments).toEqual(deriveDayAttribution(tou, 82, start, end).segments);
        expect(v1ConversionTimelineRevision(revision)).toBe(d.attribution.timelineRevision);
        expect(decodeDaySamples(d.archive, { siteId: 'site', start, end })).toEqual(rows.map(toSample));
        expect(d.metadata.summaries).toEqual(rollupDay(rows, start));
        expect(d).toMatchObject({ status: 'complete', fetchedAt: createdAt, metadata: { attributionComplete: true, sampleCount: 288 } });
        expect(readBack(start, end, d)).toEqual(rows);
    });
    it('fills a gap inside one period from its neighbours and sets status by age', () => {
        const { start, end } = day('2026-10-14');
        // 01:00-03:00 missing (off-peak on both sides), and the last hour.
        const rows = pricedRows(start, end, i => (i < 12 || i >= 36) && i < 276);
        const fresh = converted(convertV1Day(input(start, end, rows, { now: new Date(+end + 86400000) })));
        expect(fresh.attribution.segments).toHaveLength(3);
        expect(fresh).toMatchObject({ status: 'open', metadata: { sampleCount: 252, attributionComplete: true } });
        expect(converted(convertV1Day(input(start, end, rows))).status).toBe('gapped');
        expect(readBack(start, end, fresh)).toEqual(rows);
    });
    it.each([['2026-11-01', 300, [0, 540, 1320]], ['2026-03-08', 276, [0, 420, 1200]]])('converts the DST day %s by minutes from midnight', (date, slots, offsets) => {
        const { start, end } = day(date);
        const rows = pricedRows(start, end);
        expect(rows).toHaveLength(slots);
        const d = converted(convertV1Day(input(start, end, rows)));
        expect(d.attribution.segments.map(s => s.offset)).toEqual(offsets);
        expect(d).toMatchObject({ status: 'complete', archive: { expectedSlots: slots } });
        expect(readBack(start, end, d)).toEqual(rows);
    });
    it('keeps mixed schedules across a tariff version boundary exactly as recorded', () => {
        const { start, end } = day('2026-10-14');
        // A tariff save at noon: later samples were priced under version 90.
        const rows = pricedRows(start, end).map(r => +r.timestamp >= +start + 12 * 3600000
            ? { ...r, tariff_id: 90, tariff_schedule_id: r.tariff_schedule_id === 302 ? 902 : 901 } : r);
        const d = converted(convertV1Day(input(start, end, rows)));
        expect(d.attribution.segments).toEqual([{ offset: 0, tariffId: 82, scheduleId: 301 }, { offset: 480, tariffId: 82, scheduleId: 302 },
            { offset: 720, tariffId: 90, scheduleId: 902 }, { offset: 1260, tariffId: 90, scheduleId: 901 }]);
        expect(d.metadata.summaries).toEqual(rollupDay(rows, start));
        expect(readBack(start, end, d)).toEqual(rows);
    });
    it('keeps a null-schedule (fallback) day unattributed rather than inventing rates', () => {
        const { start, end } = day('2026-10-14');
        const rows = pricedRows(start, end).map(r => ({ ...r, tariff_schedule_id: null }));
        const d = converted(convertV1Day(input(start, end, rows)));
        expect(d.attribution.segments).toEqual([{ offset: 0, tariffId: 82, scheduleId: null }]);
        expect(d.metadata).toMatchObject({ attributionComplete: false, summaries: rollupDay(rows, start) });
        expect(readBack(start, end, d)).toEqual(rows);
    });
    it('leaves a day v1 when its stored summaries differ from the re-derived ones', () => {
        const { start, end } = day('2026-10-14');
        const rows = pricedRows(start, end);
        const summaries = rollupDay(rows, start).map((s, i) => i ? s : { ...s, grid_power: s.grid_power + 1e-9 });
        expect(convertV1Day(input(start, end, rows, { summaries }))).toEqual({ reason: 'summary-mismatch' });
    });
    it('leaves a day v1 when a gap spans a period boundary, which v1 billed as fully attributed', () => {
        const { start, end } = day('2026-10-14');
        // 07:00-09:00 missing: the 08:00 boundary is unknown, so v2 would mark it unattributed.
        const rows = pricedRows(start, end, i => i < 84 || i >= 108);
        expect(convertV1Day(input(start, end, rows))).toEqual({ reason: 'unattributed-gap' });
    });
    describe('with the site\'s recorded tariff versions to price gaps', () => {
        /** Prices a slot under the given tariff version, as the importer did. */
        const price = (timestamp: Date, tariffId: number) => tariffId === 82 ? Number(tou.getTariffPeriod(timestamp)?.schedule.id ?? NaN) || null : null;
        it('places a boundary inside a gap where that version puts it, converting the day as fully attributed', () => {
            const { start, end } = day('2026-10-14');
            const rows = pricedRows(start, end, i => i < 84 || i >= 108);
            const d = converted(convertV1Day(input(start, end, rows), price));
            expect(d.attribution.segments).toEqual(deriveDayAttribution(tou, 82, start, end).segments);
            expect(d.metadata).toMatchObject({ attributionComplete: true, summaries: rollupDay(rows, start) });
            expect(readBack(start, end, d)).toEqual(rows);
        });
        it('keeps the gap unattributed when that version does not reproduce the neighbouring samples\' schedules', () => {
            const { start, end } = day('2026-10-14');
            const rows = pricedRows(start, end, i => i < 84 || i >= 108);
            // A version whose peak starts at 10:00 disagrees with the recorded 09:00 sample.
            const late = (timestamp: Date, tariffId: number) => price(new Date(+timestamp - 2 * 3600000), tariffId);
            expect(convertV1Day(input(start, end, rows), late)).toEqual({ reason: 'unattributed-gap' });
        });
        it('keeps the gap unattributed when the tariff version changed during it', () => {
            const { start, end } = day('2026-10-14');
            const rows = pricedRows(start, end, i => i < 84 || i >= 108).map(r => +r.timestamp >= +start + 9 * 3600000 ? { ...r, tariff_id: 90, tariff_schedule_id: 902 } : r);
            expect(convertV1Day(input(start, end, rows), price)).toEqual({ reason: 'unattributed-gap' });
        });
        it('leaves gaps between agreeing neighbours as before', () => {
            const { start, end } = day('2026-10-14');
            const rows = pricedRows(start, end, i => i < 12 || i >= 36);
            expect(converted(convertV1Day(input(start, end, rows), price)).attribution).toEqual(converted(convertV1Day(input(start, end, rows))).attribution);
        });
    });
    it('leaves a day v1 whose flag says incomplete although every sample has a schedule', () => {
        const { start, end } = day('2026-10-14');
        expect(convertV1Day(input(start, end, pricedRows(start, end), { attributionComplete: false }))).toEqual({ reason: 'attribution-flag' });
    });
    it('leaves a day v1 when samples are off the 5-minute grid', () => {
        const { start, end } = day('2026-10-14');
        const rows = pricedRows(start, end, i => i < 10).map((r, i) => i === 3 ? { ...r, timestamp: new Date(+r.timestamp + 1000) } : r);
        expect(convertV1Day(input(start, end, rows))).toEqual({ reason: 'off-grid' });
    });
});

describe('runV1Conversion', () => {
    const candidate = (siteId: string, n: number, payloadBytes = 3000): ConversionCandidate => ({ siteId, start: new Date(Date.UTC(2026, 9, n, 5)), payloadBytes });
    const fakeRepo = (days: ConversionCandidate[], outcome: (c: ConversionCandidate) => DayConversionResult = () => ({ status: 'converted' })) => {
        const calls: { candidate: ConversionCandidate; apply: boolean }[] = [];
        const done = new Set<string>();
        const key = (c: ConversionCandidate) => `${c.siteId}/${+c.start}`;
        const repo: V1ConversionRepo = {
            async schemaReady() { return true; },
            async counts(sites) {
                const scoped = days.filter(d => !sites || sites.includes(d.siteId));
                return { v1: scoped.filter(d => !done.has(key(d))).length, v2: scoped.filter(d => done.has(key(d))).length };
            },
            async candidates(sites, after, limit) {
                return days.filter(d => !done.has(key(d)) && (!sites || sites.includes(d.siteId))
                    && (!after || +d.start > +after.start || (+d.start === +after.start && d.siteId > after.siteId)))
                    .sort((x, y) => +x.start - +y.start || x.siteId.localeCompare(y.siteId)).slice(0, limit);
            },
            async convert(c, apply) {
                calls.push({ candidate: c, apply });
                const result = outcome(c);
                if (apply && result.status === 'converted') done.add(key(c));
                return apply || result.status !== 'converted' ? result : { status: 'convertible' };
            },
        };
        return { repo, calls };
    };
    const options = { sites: null, apply: false, maxDays: 100, maxReservedBytes: 64 * 1024 * 1024, batchSize: 2, now: new Date('2026-10-24T12:00:00Z') };
    it('previews every v1 day in (day, site) order without writing, then applies and resumes as a no-op', async () => {
        const days = [candidate('a', 1), candidate('b', 1), candidate('a', 2)];
        const { repo, calls } = fakeRepo(days);
        const preview = await runV1Conversion(repo, options);
        expect(preview).toMatchObject({ mode: 'preview', stopped: 'caught-up', considered: 3, counts: { convertible: 3 }, alreadyV2: 0, remainingV1: 3 });
        expect(calls.every(c => !c.apply)).toBe(true);
        expect(calls.map(c => c.candidate)).toEqual(days);
        const applied = await runV1Conversion(repo, { ...options, apply: true });
        expect(applied).toMatchObject({ mode: 'apply', considered: 3, counts: { converted: 3 }, alreadyV2: 0, remainingV1: 0 });
        expect(await runV1Conversion(repo, { ...options, apply: true })).toMatchObject({ considered: 0, counts: {}, alreadyV2: 3, remainingV1: 0, stopped: 'caught-up' });
    });
    it('reports days left v1 with reasons and never revisits them within a run', async () => {
        const days = [candidate('a', 1), candidate('a', 2), candidate('a', 3)];
        const { repo, calls } = fakeRepo(days, c => c.start.getUTCDate() === 2 ? { status: 'left-v1', reason: 'summary-mismatch' } : { status: 'converted' });
        const report = await runV1Conversion(repo, { ...options, apply: true });
        expect(report).toMatchObject({ considered: 3, counts: { converted: 2, 'left-v1': 1 }, remainingV1: 1,
            leftV1: { byReason: { 'summary-mismatch': 1 }, days: [{ siteId: 'a', day: days[1].start.toISOString(), reason: 'summary-mismatch' }] } });
        expect(calls).toHaveLength(3);
    });
    it('scopes to the selected sites', async () => {
        const { repo, calls } = fakeRepo([candidate('a', 1), candidate('b', 1), candidate('c', 1)]);
        expect(await runV1Conversion(repo, { ...options, sites: ['a', 'c'] })).toMatchObject({ considered: 2, remainingV1: 2 });
        expect(calls.map(c => c.candidate.siteId)).toEqual(['a', 'c']);
    });
    it('stops at the per-run day cap and the reserved-transfer cap before reading the next day', async () => {
        const days = Array.from({ length: 6 }, (_, i) => candidate('a', i + 1, 4000));
        expect(await runV1Conversion(fakeRepo(days).repo, { ...options, maxDays: 4 })).toMatchObject({ considered: 4, stopped: 'day-cap' });
        const perDay = CONVERSION_DAY_BYTES + 4000;
        const capped = await runV1Conversion(fakeRepo(days).repo, { ...options, maxReservedBytes: 3 * perDay - 1 });
        expect(capped).toMatchObject({ considered: 2, stopped: 'byte-cap' });
        // Two days plus the small listing reservations, never over the cap.
        expect(capped.reservedBytes).toBeGreaterThan(2 * perDay);
        expect(capped.reservedBytes).toBeLessThanOrEqual(3 * perDay - 1);
    });
    it('resumes a capped run after the last day it examined, past days left v1', async () => {
        const days = [candidate('a', 1), candidate('b', 1), candidate('a', 2)];
        const { repo, calls } = fakeRepo(days, c => c.siteId === 'a' && c.start.getUTCDate() === 1 ? { status: 'left-v1', reason: 'off-grid' } : { status: 'converted' });
        const first = await runV1Conversion(repo, { ...options, apply: true, maxDays: 1 });
        expect(first).toMatchObject({ stopped: 'day-cap', considered: 1, resumeAfter: { siteId: 'a', day: days[0].start.toISOString() } });
        const second = await runV1Conversion(repo, { ...options, apply: true, maxDays: 1, after: { siteId: first.resumeAfter!.siteId, start: new Date(first.resumeAfter!.day) } });
        expect(second).toMatchObject({ considered: 1, counts: { converted: 1 } });
        expect(second.resumeAfter).toEqual({ siteId: 'b', day: days[1].start.toISOString() });
        const rest = await runV1Conversion(repo, { ...options, apply: true, after: { siteId: 'b', start: days[1].start } });
        expect(rest).toMatchObject({ stopped: 'caught-up', considered: 1, remainingV1: 1 });
        expect(rest.resumeAfter).toBeUndefined();
        expect(calls.map(c => c.candidate)).toEqual(days);
    });
    it('converts different sites concurrently, one day at a time per site, keeping a contiguous resume cursor', async () => {
        const days = [1, 2, 3].flatMap(n => ['a', 'b', 'c'].map(site => candidate(site, n)));
        const inFlight = new Map<string, number>();
        let peak = 0;
        const sameSite: string[] = [];
        const repo: V1ConversionRepo = {
            ...fakeRepo(days).repo,
            async convert(c) {
                if (inFlight.has(c.siteId)) sameSite.push(c.siteId);
                inFlight.set(c.siteId, 1);
                peak = Math.max(peak, inFlight.size);
                await new Promise(resolve => setTimeout(resolve, 5));
                inFlight.delete(c.siteId);
                return c.siteId === 'b' && c.start.getUTCDate() === 1 ? { status: 'left-v1', reason: 'off-grid' } : { status: 'convertible' };
            },
        };
        const all = await runV1Conversion(repo, { ...options, concurrency: 3, batchSize: 9 });
        expect(peak).toBe(3);
        expect(sameSite).toEqual([]);
        expect(all).toMatchObject({ considered: 9, counts: { convertible: 8, 'left-v1': 1 }, stopped: 'caught-up' });
        // A cap stops at a whole prefix in (site, day) order, so resuming skips nothing.
        const capped = await runV1Conversion(repo, { ...options, concurrency: 3, batchSize: 9, maxDays: 4 });
        expect(capped).toMatchObject({ considered: 4, stopped: 'day-cap', resumeAfter: { siteId: 'a', day: days[3].start.toISOString() } });
        expect(capped.leftV1.days).toEqual([{ siteId: 'b', day: days[1].start.toISOString(), reason: 'off-grid' }]);
    });
    it('stops starting days once one fails, and rethrows', async () => {
        const days = [1, 2, 3].flatMap(n => ['a', 'b'].map(site => candidate(site, n)));
        const seen: string[] = [];
        const repo: V1ConversionRepo = { ...fakeRepo(days).repo, async convert(c) {
            seen.push(`${c.siteId}${c.start.getUTCDate()}`);
            await new Promise(resolve => setTimeout(resolve, 5));
            if (c.siteId === 'a') throw new Error('connection lost');
            return { status: 'convertible' };
        } };
        await expect(runV1Conversion(repo, { ...options, concurrency: 2, batchSize: 6 })).rejects.toThrow('connection lost');
        expect(seen).toEqual(['a1', 'b1']);
    });
    it('refuses to start, preview included, until the v2 schema migration has run', async () => {
        const { repo, calls } = fakeRepo([candidate('a', 1)]);
        const counted: unknown[] = [];
        const unmigrated: V1ConversionRepo = { ...repo, async schemaReady() { return false; }, async counts(sites) { counted.push(sites); return repo.counts(sites); } };
        for (const apply of [false, true]) {
            await expect(runV1Conversion(unmigrated, { ...options, apply })).rejects.toThrow(ConversionUsageError);
            await expect(runV1Conversion(unmigrated, { ...options, apply })).rejects.toThrow(/20261024190000_day_record_v2_schema/);
        }
        expect(calls).toEqual([]);
        expect(counted).toEqual([]);
    });
    it('counts busy days without stopping', async () => {
        const { repo } = fakeRepo([candidate('a', 1), candidate('a', 2)], c => c.start.getUTCDate() === 1 ? { status: 'busy' } : { status: 'converted' });
        expect(await runV1Conversion(repo, { ...options, apply: true })).toMatchObject({ counts: { busy: 1, converted: 1 }, remainingV1: 1 });
    });
});

describe('parseConversionArgs', () => {
    it('previews all sites by default and takes repeatable site IDs, apply and caps', () => {
        expect(parseConversionArgs([])).toEqual({ sites: null, apply: false, maxDays: 500, maxReservedBytes: 16 * 1024 * 1024, after: null, concurrency: 1 });
        expect(parseConversionArgs(['--concurrency', '4']).concurrency).toBe(4);
        expect(parseConversionArgs(['--site-id', 'a', '--site-id', 'b', '--apply', '--max-days', '50', '--max-mb', '4']))
            .toEqual({ sites: ['a', 'b'], apply: true, maxDays: 50, maxReservedBytes: 4 * 1024 * 1024, after: null, concurrency: 1 });
        // The report's resumeAfter, passed back as is.
        expect(parseConversionArgs(['--after', 'site 1/2026-10-01T05:00:00.000Z']).after).toEqual({ siteId: 'site 1', start: new Date('2026-10-01T05:00:00.000Z') });
    });
    it.each([[['--max-days', '0']], [['--max-days', '5001']], [['--max-mb', '257']], [['--site-id']], [['--bogus', '1']], [['--after', 'site']], [['--after', 'site/yesterday']], [['--concurrency', '0']], [['--concurrency', '5']]])('rejects %j', args => {
        expect(() => parseConversionArgs(args)).toThrow();
    });
});
