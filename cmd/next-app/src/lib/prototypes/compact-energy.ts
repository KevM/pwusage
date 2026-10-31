/** Lossless format-2 sample payloads for persisted energy day records. */
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from 'node:zlib';
import type { EnergyData } from '../db-types';

export type ArchiveCodec = 'gzip' | 'brotli';
const INTERVAL_MS = 300000;
const MAX_SAMPLES = 4096;
const MAX_BYTES = 1024 * 1024;
const sampleColumns = ['load_power', 'solar_power', 'grid_power', 'battery_power', 'battery_soc'] as const;
/** Format 2 stores only Tesla's measurements; tariff attribution lives in the day's segment timeline. */
interface Header { version: 2; site: string; start: number; end: number; axis: 'grid' | 'offsets'; positions: number[] }
export type EnergySample = Omit<EnergyData, 'id' | 'tariff_id' | 'tariff_schedule_id'>;
export interface DayArchive { codec: ArchiveCodec; sha256: string; data: Buffer; axis: Header['axis']; expectedSlots: number }
export interface DayRollup {
    site_id: string; day: Date; tariff_id: number; tariff_schedule_id: number | null;
    load_power: number; solar_power: number; grid_power: number; battery_power: number;
    sample_import_wh: number; sample_export_wh: number; sample_charge_wh: number; sample_discharge_wh: number; sample_count: number;
}

function validateSamples(rows: EnergySample[], start: Date, end: Date): void {
    if (!Number.isSafeInteger(+start) || !Number.isSafeInteger(+end) || end <= start || +end - +start > 27 * 3600000) throw new Error('Invalid day bounds');
    if (rows.length > MAX_SAMPLES) throw new Error('Too many samples');
    let previous = +start - 1;
    for (const row of rows) {
        if (!row.site_id || row.site_id !== rows[0].site_id || !Number.isSafeInteger(+row.timestamp) || +row.timestamp <= previous || row.timestamp < start || row.timestamp >= end) throw new Error('Invalid sample identity/time');
        for (const key of sampleColumns) {
            const value = row[key];
            if (value === null && key === 'battery_soc') continue;
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Nonfinite sample');
        }
        previous = +row.timestamp;
    }
}

export function compress(data: Buffer, codec: ArchiveCodec): Buffer {
    if (codec === 'gzip') return gzipSync(data);
    if (codec === 'brotli') return brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } });
    throw new Error('Unknown codec');
}

function encode(rows: EnergySample[], start: Date, end: Date, codec: ArchiveCodec): DayArchive {
    const keys = sampleColumns;
    const axis = rows.every(row => (+row.timestamp - +start) % INTERVAL_MS === 0) ? 'grid' : 'offsets';
    const header: Header = { version: 2, site: rows[0]?.site_id ?? '', start: +start, end: +end, axis,
        positions: rows.map(row => (+row.timestamp - +start) / (axis === 'grid' ? INTERVAL_MS : 1)) };
    const json = Buffer.from(JSON.stringify(header));
    const bytes = Buffer.alloc(4 + json.length + rows.length * keys.length * 8);
    bytes.writeUInt32LE(json.length, 0); json.copy(bytes, 4);
    let offset = 4 + json.length;
    // Column-major Float64 preserves the original JS double, including -0.
    // NaN is reserved exclusively for nullable SoC values.
    for (const key of keys) for (const row of rows) {
        bytes.writeDoubleLE(row[key] ?? NaN, offset); offset += 8;
    }
    return { codec, sha256: createHash('sha256').update(bytes).digest('hex'), data: compress(bytes, codec), axis,
        expectedSlots: Math.ceil((+end - +start) / INTERVAL_MS) };
}

/** Format 2: Tesla's measurements only. */
export function encodeDaySamples(samples: EnergySample[], start: Date, end: Date, codec: ArchiveCodec): DayArchive {
    validateSamples(samples, start, end);
    return encode(samples, start, end, codec);
}

function parseHeader(value: unknown): Header {
    if (!value || typeof value !== 'object') throw new Error('Invalid header');
    const h = value as Record<string, unknown>;
    if (h.version !== 2 || typeof h.site !== 'string' || h.site.length > 1024 || typeof h.start !== 'number' || typeof h.end !== 'number'
        || (h.axis !== 'grid' && h.axis !== 'offsets') || !Array.isArray(h.positions) || h.positions.length > MAX_SAMPLES
        || !h.positions.every((p: unknown) => typeof p === 'number' && Number.isSafeInteger(p) && p >= 0)) throw new Error('Invalid header');
    return { version: h.version, site: h.site, start: h.start, end: h.end, axis: h.axis, positions: h.positions as number[] };
}

type Identity = { siteId: string; start: Date; end: Date };

/** Verify an archive (size, bounded decompression, checksum, header, identity, data length); returns its header and where its data starts. */
function openArchive(archive: DayArchive, identity?: Identity): { header: Header; bytes: Buffer; dataOffset: number } {
    if (archive.data.length > MAX_BYTES) throw new Error('Archive too large');
    const bytes = archive.codec === 'gzip' ? gunzipSync(archive.data, { maxOutputLength: MAX_BYTES })
        : archive.codec === 'brotli' ? brotliDecompressSync(archive.data, { maxOutputLength: MAX_BYTES }) : (() => { throw new Error('Unknown codec'); })();
    if (createHash('sha256').update(bytes).digest('hex') !== archive.sha256 || bytes.length < 4) throw new Error('Invalid archive checksum');
    const length = bytes.readUInt32LE(0);
    if (length > bytes.length - 4) throw new Error('Truncated header');
    const h = parseHeader(JSON.parse(bytes.subarray(4, 4 + length).toString('utf8')) as unknown);
    if (identity && (h.start !== +identity.start || h.end !== +identity.end || (h.positions.length > 0 && h.site !== identity.siteId))) throw new Error('Archive identity mismatch');
    const dataOffset = 4 + length;
    if (bytes.length !== dataOffset + h.positions.length * sampleColumns.length * 8) throw new Error('Invalid data length');
    return { header: h, bytes, dataOffset };
}

/** Rows carrying each sample's timestamp; measurement columns are filled in by the caller. */
function timestampedRows(h: Header): EnergySample[] {
    return h.positions.map(p => ({ site_id: h.site, timestamp: new Date(h.start + p * (h.axis === 'grid' ? INTERVAL_MS : 1)),
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null }));
}

function decode(archive: DayArchive, identity?: Identity): EnergySample[] {
    const { header: h, bytes, dataOffset } = openArchive(archive, identity);
    const rows = timestampedRows(h);
    let offset = dataOffset;
    for (const key of sampleColumns) for (const row of rows) {
        const n = bytes.readDoubleLE(offset); offset += 8;
        if (key === 'battery_soc') row[key] = Number.isNaN(n) ? null : n;
        else row[key] = n;
    }
    validateSamples(rows, new Date(h.start), new Date(h.end));
    return rows;
}

/** A measurement without derived tariff labels. */
export const toSample = (row: EnergySample): EnergySample => ({ site_id: row.site_id, timestamp: row.timestamp, load_power: row.load_power,
    solar_power: row.solar_power, grid_power: row.grid_power, battery_power: row.battery_power, battery_soc: row.battery_soc ?? null });

/** Read format-2 measurements; tariff labels come from the separate attribution timeline. */
export function decodeDaySamples(archive: DayArchive, identity?: { siteId: string; start: Date; end: Date }): EnergySample[] {
    return decode(archive, identity);
}

/** Read only the solar channel of a day archive, with the same integrity checks as `decodeDaySamples`. */
export function decodeDaySolar(archive: DayArchive, identity?: Identity): { timestamp: Date; solarWh: number }[] {
    const { header: h, bytes, dataOffset } = openArchive(archive, identity);
    const solarOffset = dataOffset + h.positions.length * 8 * sampleColumns.indexOf('solar_power');
    const rows = timestampedRows(h).map((row, i) => ({ ...row, solar_power: bytes.readDoubleLE(solarOffset + i * 8) }));
    validateSamples(rows, new Date(h.start), new Date(h.end));
    return rows.map(row => ({ timestamp: row.timestamp, solarWh: row.solar_power }));
}

export function rollupDay(rows: EnergyData[], day: Date): DayRollup[] {
    const groups = new Map<string, DayRollup>();
    for (const row of rows) {
        const key = JSON.stringify([row.site_id, row.tariff_id, row.tariff_schedule_id]);
        let summary = groups.get(key);
        if (!summary) {
            summary = { site_id: row.site_id, day, tariff_id: row.tariff_id, tariff_schedule_id: row.tariff_schedule_id,
                load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, sample_import_wh: 0, sample_export_wh: 0,
                sample_charge_wh: 0, sample_discharge_wh: 0, sample_count: 0 };
            groups.set(key, summary);
        }
        for (const key of ['load_power', 'solar_power', 'grid_power', 'battery_power'] as const) summary[key] += row[key];
        summary.sample_import_wh += Math.max(row.grid_power, 0); summary.sample_export_wh += Math.max(-row.grid_power, 0);
        summary.sample_charge_wh += Math.max(row.battery_power, 0); summary.sample_discharge_wh += Math.max(-row.battery_power, 0);
        summary.sample_count++;
    }
    return [...groups.values()];
}
