/**
 * One-time v1 -> v2 conversion of `EnergyDayArchive` records
 * (docs/plans/2026-10-24-day-record-v2.md, "Migrating existing archives").
 * A day converts only when its v2 record reads back exactly as the v1 archive
 * did; any mismatch leaves it v1 with a reason. Raw `EnergyData` is never touched.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { EnergyData } from '../db-types';
import { decodeDaySamples, encodeDaySamples, rollupDay, toSample, type DayArchive, type DayRollup } from './compact-energy';
import { equalRecoveryValue, recoverVerifiedSamples } from './compact-energy-recovery';
import { buildDayMetadataV3, type SummarizedHistoryDay } from './compact-day-metadata';
import { buildLatestMetadata, type LatestMetadata } from './compact-latest-metadata';
import { attributeSamples, dayStatus, segmentsFromV1Rows, type DayAttribution, type DayStatus } from './day-attribution';
import type { CompactHistoryStore, DayConversionResult } from './compact-history-store';

/**
 * Why a day stays v1. `integrity`: the v1 archive itself fails reader
 * verification. `unattributed-gap`: a missing stretch spans a period boundary,
 * which v2 marks unattributed although v1 billed the day as complete.
 * `attribution-flag`: v1 says incomplete although every sample has a schedule.
 */
export type V1ConversionReason = 'legacy-metadata'|'day-bounds'|'integrity'|'off-grid'|'sample-mismatch'|'attribution-mismatch'
    |'summary-mismatch'|'unattributed-gap'|'attribution-flag'|'verification';
export const v1ConversionTimelineRevision = (revision: string): string => `v1-conversion:${revision}`;

export interface V1Day {
    siteId: string; start: Date; end: Date; revision: string; createdAt: Date; attributionComplete: boolean;
    /** Verified v1 samples with their per-sample tariff IDs. */
    rows: EnergyData[];
    /** The stored `EnergyDaySummary` rows for the archive's revision. */
    summaries: DayRollup[];
    now: Date;
}
export interface ConvertedDay {
    archive: DayArchive; attribution: DayAttribution; metadata: SummarizedHistoryDay; status: DayStatus; fetchedAt: Date;
    latest: { data: LatestMetadata; checksum: string }; payloadChecksum: string;
}

const sortSummaries = (rows: DayRollup[]) => [...rows].sort((a, b) => a.tariff_id - b.tariff_id || (a.tariff_schedule_id ?? -1) - (b.tariff_schedule_id ?? -1));

/** Builds the v2 record for a verified v1 day, or says why the day must stay v1. Pure. */
export function convertV1Day(day: V1Day): { day: ConvertedDay } | { reason: V1ConversionReason } {
    const { siteId, start, end, rows } = day;
    let segments;
    // The v1 helper refuses samples off the 5-minute slots, which segments cannot address.
    try { segments = segmentsFromV1Rows(rows, start, end); } catch { return { reason: 'off-grid' }; }
    const attribution: DayAttribution = { timelineRevision: v1ConversionTimelineRevision(day.revision), segments };
    const samples = rows.map(toSample);
    const archive = encodeDaySamples(samples, start, end, 'brotli');
    const decoded = decodeDaySamples(archive, { siteId, start, end });
    if (!equalRecoveryValue(decoded, samples)) return { reason: 'sample-mismatch' };
    if (!equalRecoveryValue(attributeSamples(decoded, attribution, start, end), rows)) return { reason: 'attribution-mismatch' };
    const metadata = buildDayMetadataV3(decoded, attribution, start, end);
    if (!equalRecoveryValue(sortSummaries(metadata.summaries), sortSummaries(day.summaries))
        || !equalRecoveryValue(sortSummaries(metadata.summaries), sortSummaries(rollupDay(rows, start)))) return { reason: 'summary-mismatch' };
    if (metadata.attributionComplete !== day.attributionComplete) return { reason: metadata.attributionComplete ? 'attribution-flag' : 'unattributed-gap' };
    const status = dayStatus({ end, sampleCount: decoded.length, expectedSlots: archive.expectedSlots, now: day.now });
    const latest = buildLatestMetadata(decoded, { siteId, start, end, archiveChecksum: archive.sha256 });
    const converted: ConvertedDay = { archive, attribution, metadata, status, fetchedAt: day.createdAt, latest,
        payloadChecksum: createHash('sha256').update(archive.data).digest('hex') };
    // Read the new record back exactly as recovery and trim will.
    try {
        const recovered = recoverVerifiedSamples({ site_id: siteId, day_start: start, day_end: end, revision: day.revision, format_version: 2,
            codec: archive.codec, axis: archive.axis, checksum: archive.sha256, payload: archive.data, expected_slots: archive.expectedSlots,
            sample_count: metadata.sampleCount, attribution_complete: metadata.attributionComplete, first_timestamp: metadata.first, last_timestamp: metadata.last,
            max_interior_gap_ms: metadata.maxInteriorGapMs, metadata_checksum: metadata.checksum, metadata_version: 3,
            latest_metadata: JSON.parse(JSON.stringify(latest.data)) as LatestMetadata, latest_checksum: latest.checksum,
            payload_checksum: converted.payloadChecksum, raw_pruned: false, attribution, status, fetched_at: day.createdAt }, day.summaries);
        if (!equalRecoveryValue(recovered, rows)) return { reason: 'verification' };
    } catch { return { reason: 'verification' }; }
    return { day: converted };
}

export interface ConversionCandidate { siteId: string; start: Date; payloadBytes: number }
export interface V1ConversionRepo {
    /** v1 and v2 record counts in scope (`null` = every site). */
    counts(sites: string[] | null): Promise<{ v1: number; v2: number }>;
    /** v1 days after the keyset cursor, in (site, day) order. */
    candidates(sites: string[] | null, after: { siteId: string; start: Date } | null, limit: number): Promise<ConversionCandidate[]>;
    convert(candidate: ConversionCandidate, apply: boolean, now: Date): Promise<DayConversionResult>;
}
export interface V1ConversionOptions { sites: string[] | null; apply: boolean; maxDays: number; maxReservedBytes: number; batchSize?: number; now: Date }
export interface V1ConversionReport {
    mode: 'preview' | 'apply'; stopped: 'caught-up' | 'day-cap' | 'byte-cap';
    /** v1 days examined this run. */
    considered: number;
    /** By result: `converted` (apply) or `convertible` (preview), `left-v1`, `busy`. */
    counts: Partial<Record<DayConversionResult['status'], number>>;
    /** v2 records in scope when the run started (converted earlier, or written as v2). */
    alreadyV2: number;
    remainingV1: number;
    leftV1: { byReason: Partial<Record<V1ConversionReason, number>>; days: { siteId: string; day: string; reason: V1ConversionReason }[] };
    /** Conservative read reservation (not wire bytes), compared with `maxReservedBytes`. */
    reservedBytes: number;
}

/**
 * Per-day read reservation on top of the stored payload: the archive row's
 * metadata and projection, its few summary rows, site and verification queries
 * and protocol framing. Checked against measured PostgreSQL response bytes in
 * the integration tests.
 */
export const CONVERSION_DAY_BYTES = 24 * 1024;
const LISTING_BYTES = 4096;

export async function runV1Conversion(repo: V1ConversionRepo, options: V1ConversionOptions): Promise<V1ConversionReport> {
    const batchSize = options.batchSize ?? 50;
    const start = await repo.counts(options.sites);
    const report: V1ConversionReport = { mode: options.apply ? 'apply' : 'preview', stopped: 'caught-up', considered: 0, counts: {}, alreadyV2: start.v2,
        remainingV1: start.v1, leftV1: { byReason: {}, days: [] }, reservedBytes: LISTING_BYTES };
    // Keyset cursor: a day left v1 is examined once per run, so a run always ends.
    let after: { siteId: string; start: Date } | null = null;
    scan: for (;;) {
        report.reservedBytes += LISTING_BYTES;
        const batch = await repo.candidates(options.sites, after, batchSize);
        if (!batch.length) break;
        for (const candidate of batch) {
            if (report.considered >= options.maxDays) { report.stopped = 'day-cap'; break scan; }
            const reserve = CONVERSION_DAY_BYTES + candidate.payloadBytes;
            if (report.reservedBytes + reserve > options.maxReservedBytes) { report.stopped = 'byte-cap'; break scan; }
            report.reservedBytes += reserve;
            report.considered++;
            after = { siteId: candidate.siteId, start: candidate.start };
            const result = await repo.convert(candidate, options.apply, options.now);
            report.counts[result.status] = (report.counts[result.status] ?? 0) + 1;
            if (result.status === 'left-v1') {
                const reason = result.reason!;
                report.leftV1.byReason[reason] = (report.leftV1.byReason[reason] ?? 0) + 1;
                report.leftV1.days.push({ siteId: candidate.siteId, day: candidate.start.toISOString(), reason });
            }
        }
        if (batch.length < batchSize) break;
    }
    report.remainingV1 = (await repo.counts(options.sites)).v1;
    return report;
}

/** PostgreSQL candidates and counts; payload sizes are computed server side, never transferred. */
export class V1ConversionPgRepo implements V1ConversionRepo {
    constructor(private readonly pool: Pool, private readonly store: CompactHistoryStore) {}
    async counts(sites: string[] | null) {
        const row = (await this.pool.query<{ v1: number; v2: number }>(`SELECT count(*) FILTER (WHERE format_version=1)::int AS v1,
            count(*) FILTER (WHERE format_version=2)::int AS v2 FROM "EnergyDayArchive" WHERE $1::text[] IS NULL OR site_id=ANY($1)`, [sites])).rows[0];
        return { v1: row.v1, v2: row.v2 };
    }
    async candidates(sites: string[] | null, after: { siteId: string; start: Date } | null, limit: number) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid conversion batch');
        const rows = (await this.pool.query<{ site_id: string; day_start: Date; bytes: number }>(`SELECT site_id,day_start,octet_length(payload) AS bytes
            FROM "EnergyDayArchive" WHERE format_version=1 AND ($1::text[] IS NULL OR site_id=ANY($1))
            AND ($2::text IS NULL OR (site_id,day_start)>($2,$3::timestamptz)) ORDER BY site_id,day_start LIMIT $4`,
        [sites, after?.siteId ?? null, after?.start ?? null, limit])).rows;
        return rows.map(r => ({ siteId: r.site_id, start: new Date(r.day_start), payloadBytes: Number(r.bytes) }));
    }
    convert(candidate: ConversionCandidate, apply: boolean, now: Date) {
        return this.store.convertDayToV2(candidate.siteId, candidate.start, { apply, now });
    }
}

/** Operator input errors, safe to print. */
export class ConversionUsageError extends Error {}
const USAGE = 'Usage: [--site-id <id>]... [--apply] [--max-days 1-5000] [--max-mb 1-256]';
export function parseConversionArgs(args: string[]): Omit<V1ConversionOptions, 'now' | 'batchSize'> {
    const sites: string[] = [];
    let apply = false, maxDays = 500, maxMb = 16;
    for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (key === '--apply') { apply = true; continue; }
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new ConversionUsageError(`Missing value for ${key}. ${USAGE}`);
        if (key === '--site-id' && value.trim() && value.length <= 200) sites.push(value);
        else if (key === '--max-days') maxDays = Number(value);
        else if (key === '--max-mb') maxMb = Number(value);
        else throw new ConversionUsageError(`Unknown argument ${key}. ${USAGE}`);
    }
    if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 5000 || !Number.isInteger(maxMb) || maxMb < 1 || maxMb > 256) throw new ConversionUsageError(USAGE);
    return { sites: sites.length ? [...new Set(sites)] : null, apply, maxDays, maxReservedBytes: maxMb * 1024 * 1024 };
}
