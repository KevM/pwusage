import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { EnergyData, SiteWithTariffs, Tariff, TariffSchedule, TariffSeason } from '../src/lib/db-types';
import { addDaysInSiteTimezone, getSiteMidnight, parseSiteLocalDateToMidnight } from '../src/lib/date-utils';
import { compress, decodeDay, encodeDay, rollupDay } from '../src/lib/prototypes/compact-energy';
import { auditTariffAttribution } from '../src/lib/prototypes/compact-tariff-audit';

interface SampleDay { label: string; start: Date; end: Date; rows: EnergyData[]; site?: SiteWithTariffs; tariffs?: Tariff[]; schedules?: TariffSchedule[] }
let stage = 'initialization';
interface Measurement { label: string; samples: number; expectedSlots: number; axis: string; rollupRows: number; nullScheduleSamples: number; missingScheduleSamples: number; rowJsonBytes: number; columnJsonGzipBytes: number; columnJsonBrotliBytes: number; binaryGzipBytes: number; binaryBrotliBytes: number; encodeMs: number; decodeMs: number; lossless: boolean; billingParity: boolean | null; coverage: string; attribution?: { inferredSamples: number; unresolvedSamples: number; recordedPeriodDisagreements: number; economicBuckets: number; repairedBillingParity: boolean | null; unresolvedReasons: Record<string, number>; uniquePeriodNames: number; uniquePrices: number } }

function syntheticDays(): SampleDay[] {
    return ['2026-10-01', '2026-03-08', '2026-11-01', '2026-10-02'].map((date, dayIndex) => {
        const start = parseSiteLocalDateToMidnight(date, 'America/Chicago');
        const end = addDaysInSiteTimezone(start, 1, 'America/Chicago');
        const rows: EnergyData[] = Array.from({ length: (+end - +start) / 300000 }, (_, i) => ({
            timestamp: new Date(+start + i * 300000), site_id: 'synthetic', tariff_id: 1, tariff_schedule_id: i % 288 < 180 ? 1 : 2,
            load_power: 50 + 30 * Math.sin(i / 12), solar_power: Math.max(0, 150 * Math.sin((i - 72) / 144 * Math.PI)),
            grid_power: 50 * Math.cos(i / 36), battery_power: 10 * Math.sin(i / 24), battery_soc: i % 5 === 0 ? null : 50 + 20 * Math.sin(i / 50),
        }));
        if (dayIndex === 0) { rows.splice(10, 3); rows[30].timestamp = new Date(+rows[30].timestamp + 123); }
        return { label: `synthetic-${date}`, start, end, rows };
    });
}

function sameNumbers(left: unknown, right: unknown): boolean {
    if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((v: unknown, i: number) => sameNumbers(v, right[i]));
    if (left && right && typeof left === 'object' && typeof right === 'object') {
        const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
        return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => sameNumbers(a[k], b[k]));
    }
    return left === right;
}

async function billingParity(day: SampleDay): Promise<boolean | null> {
    if (!day.site || !day.tariffs || !day.schedules) return null;
    const { EnergyRepo } = await import('../src/lib/energy-repo');
    const { Schedule } = await import('../src/lib/schedule');
    const { aggregateUsage } = await import('../src/lib/tou-aggregation');
    const schedule = new Schedule(day.site.tariffs, day.site.timezone);
    const maps = EnergyRepo.buildTariffLookupMaps(day.site.tariffs, day.tariffs, day.schedules);
    // A per-sample reference isolates grouping from compression; same historical
    // IDs and day boundary on both sides. This is parity, not proof of correct
    // attribution for unresolved schedules (reported separately).
    const reference = day.rows.map(row => ({ ...row, day: day.start }));
    const summaries = rollupDay(day.rows, day.start);
    const web = (priorAggregates: typeof reference | typeof summaries) => EnergyRepo.aggregateUsageByTOU({ siteId: day.site!.id, start: day.start, priorAggregates, todayRaw: [], schedule, ...maps })
        .map(({ homeUsage, gridUsage, solarProduction, batteryChange, cost, buyRate, sellRate, touName }) => ({ homeUsage, gridUsage, solarProduction, batteryChange, cost, buyRate, sellRate, touName }));
    const trmnl = (priorAggregates: typeof reference | typeof summaries) => {
        const result = aggregateUsage(day.site!, priorAggregates, [], schedule, day.tariffs, day.schedules);
        return { tariffGroups: result.tariffGroups, totalBillCost: result.totalBillCost };
    };
    return sameNumbers(web(reference), web(summaries)) && sameNumbers(trmnl(reference), trmnl(summaries));
}

async function measure(day: SampleDay): Promise<Measurement> {
    const t = performance.now();
    const gzip = encodeDay(day.rows, day.start, day.end, 'gzip');
    const brotli = encodeDay(day.rows, day.start, day.end, 'brotli');
    const encodeMs = (performance.now() - t) / 2;
    const d = performance.now();
    const decoded = decodeDay(brotli);
    const decodeMs = performance.now() - d;
    const lossless = isDeepStrictEqual(decoded, day.rows) && isDeepStrictEqual(decodeDay(gzip), day.rows);
    const parity = await billingParity(day);
    if (!lossless || parity === false) throw new Error('Archive or billing reconciliation failed');
    const rollups = rollupDay(day.rows, day.start);
    const columnJson = Buffer.from(JSON.stringify({ start: +day.start, end: +day.end,
        positions: day.rows.map(r => +r.timestamp - +day.start),
        columns: ['tariff_id', 'tariff_schedule_id', 'load_power', 'solar_power', 'grid_power', 'battery_power', 'battery_soc'].map(key => day.rows.map(row => row[key as keyof EnergyData])) }));
    const scheduleIds = new Set(day.schedules?.map(s => s.id));
    const audit = day.site && day.tariffs && day.schedules ? auditTariffAttribution(day.rows, day.site.timezone, day.tariffs, day.schedules) : undefined;
    return { label: day.label, samples: day.rows.length, expectedSlots: brotli.expectedSlots, axis: brotli.axis, rollupRows: rollups.length,
        nullScheduleSamples: day.rows.filter(r => r.tariff_schedule_id === null).length,
        missingScheduleSamples: day.schedules ? day.rows.filter(r => r.tariff_schedule_id !== null && !scheduleIds.has(r.tariff_schedule_id)).length : 0,
        rowJsonBytes: Buffer.byteLength(JSON.stringify(day.rows)), columnJsonGzipBytes: compress(columnJson, 'gzip').length,
        columnJsonBrotliBytes: compress(columnJson, 'brotli').length, binaryGzipBytes: gzip.data.length, binaryBrotliBytes: brotli.data.length,
        encodeMs, decodeMs, lossless, billingParity: parity,
        attribution: audit ? { inferredSamples: audit.inferredSamples, unresolvedSamples: audit.unresolvedSamples, recordedPeriodDisagreements: audit.recordedPeriodDisagreements,
            economicBuckets: audit.periods.length, repairedBillingParity: await billingParity({ ...day, rows: audit.rows }), unresolvedReasons: audit.unresolvedReasons,
            uniquePeriodNames: audit.uniquePeriodNames, uniquePrices: audit.uniquePrices } : undefined,
        coverage: day.rows.length === brotli.expectedSlots && brotli.axis === 'grid' ? 'full grid' : 'partial/irregular' };
}

async function databaseDays(siteLimit: number): Promise<SampleDay[]> {
    const { pool } = await import('../src/lib/db');
    const { SiteRepo } = await import('../src/lib/site-repo');
    const { TariffRepo } = await import('../src/lib/tariff-repo');
    stage = 'database connection';
    const client = await pool.connect();
    const days: SampleDay[] = [];
    try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '15s'");
        stage = 'read-only site selection';
        const sites = await client.query<{ id: string; timezone: string }>('SELECT id, timezone FROM "Site" s WHERE EXISTS (SELECT 1 FROM "EnergyData" e WHERE e.site_id = s.id) ORDER BY id LIMIT $1', [siteLimit]);
        for (const [index, s] of sites.rows.entries()) {
            const latest = await client.query<{ timestamp: Date }>(`SELECT timestamp FROM "EnergyData" WHERE site_id = $1 ORDER BY timestamp DESC LIMIT 1`, [s.id]);
            if (!latest.rows[0]) continue;
            const latestStart = getSiteMidnight(latest.rows[0].timestamp, s.timezone);
            const starts = [1, 2, 3, 30, 90, 180].map(n => addDaysInSiteTimezone(latestStart, -n, s.timezone));
            starts.push(parseSiteLocalDateToMidnight('2026-03-08', s.timezone), parseSiteLocalDateToMidnight('2025-11-02', s.timezone));
            // These repositories only read; billing metadata is small. Sample
            // reads use the explicit read-only transaction and bounded queries.
            stage = 'read-only tariff metadata';
            const site = await new SiteRepo().getSite(s.id);
            const tariffs = await new TariffRepo().getTariffsForSite(s.id);
            const schedules = await new TariffRepo().getSchedulesForSite(s.id);
            const seasons = await client.query<TariffSeason>('SELECT s.* FROM "TariffSeason" s JOIN "Tariff" t ON t.id = s.tariff_id WHERE t.site_id = $1', [s.id]);
            for (const tariff of tariffs) tariff.seasons = seasons.rows.filter(season => Number(season.tariff_id) === tariff.id).map(season => ({ ...season,
                id: Number(season.id), tariff_id: Number(season.tariff_id), from_month: Number(season.from_month), from_day: Number(season.from_day), to_month: Number(season.to_month), to_day: Number(season.to_day),
                buy_rate: Number(season.buy_rate), sell_rate: Number(season.sell_rate), schedules: schedules.filter(schedule => schedule.season_id === Number(season.id)) }));
            for (const [dayIndex, start] of [...new Map(starts.map(start => [+start, start])).values()].entries()) {
                const end = addDaysInSiteTimezone(start, 1, s.timezone);
                stage = 'bounded sample read';
                const result = await client.query<EnergyData>(`SELECT site_id, timestamp, tariff_id, tariff_schedule_id,
                    load_power, solar_power, grid_power, battery_power, battery_soc FROM "EnergyData"
                    WHERE site_id = $1 AND timestamp >= $2::timestamptz AND timestamp < $3::timestamptz ORDER BY timestamp LIMIT 4097`, [s.id, start.toISOString(), end.toISOString()]);
                const rows = result.rows.map(row => ({ ...row, tariff_id: Number(row.tariff_id), tariff_schedule_id: row.tariff_schedule_id === null ? null : Number(row.tariff_schedule_id),
                    load_power: Number(row.load_power), solar_power: Number(row.solar_power), grid_power: Number(row.grid_power), battery_power: Number(row.battery_power),
                    battery_soc: row.battery_soc === null ? null : Number(row.battery_soc) }));
                if (rows.length) days.push({ label: `database-site-${index + 1}-day-${dayIndex + 1}`, start, end, rows, site, tariffs, schedules });
            }
        }
        await client.query('ROLLBACK');
    } finally { client.release(); await pool.end(); }
    return days;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let database = false; let output: string | undefined; let siteLimit = 3; let storageSocket: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (seen.has(arg)) throw new Error('Duplicate argument'); seen.add(arg);
        if (arg === '--database') database = true;
        else if (['--output', '--sites', '--storage-socket'].includes(arg)) {
            const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('Missing argument');
            if (arg === '--output') output = value; else if (arg === '--storage-socket') storageSocket = value; else siteLimit = Number(value);
        } else throw new Error('Unknown argument');
    }
    if (!Number.isInteger(siteLimit) || siteLimit < 1 || siteLimit > 50 || (storageSocket && !database)) throw new Error('Invalid benchmark configuration');
    const days = database ? await databaseDays(siteLimit) : syntheticDays();
    if (!days.length) throw new Error('No samples found');
    stage = 'archive and billing reconciliation';
    const measurements = await Promise.all(days.map(measure));
    let storage: unknown = null;
    if (storageSocket) {
        stage = 'isolated local storage benchmark';
        const { measureStorage } = await import('../src/lib/prototypes/compact-storage-benchmark');
        storage = await measureStorage(days.filter(day => day.site && day.tariffs && day.schedules).map(day => ({ rows: day.rows, start: day.start, end: day.end,
            timezone: day.site!.timezone, tariffs: day.tariffs!, schedules: day.schedules! })), storageSocket);
    }
    const complete = measurements.filter(m => m.coverage === 'full grid' && m.samples === 288);
    const mean = (key: 'binaryBrotliBytes' | 'columnJsonBrotliBytes' | 'rollupRows') => complete.length ? complete.reduce((sum, m) => sum + m[key], 0) / complete.length : null;
    const binary = mean('binaryBrotliBytes'); const json = mean('columnJsonBrotliBytes'); const rollups = mean('rollupRows');
    const report = { measuredAt: new Date().toISOString(), source: database ? 'configured database (read only)' : 'synthetic', storage, measurements,
        projection: { representativeCompleteDays: complete.length, meanBinaryBrotliBytes: binary, meanColumnJsonBrotliBytes: json, meanRollupRows: rollups,
            annualBinaryPayloadMB: binary === null ? null : binary * 365 / 1e6,
            annualSummaryBudgetMB: rollups === null ? null : rollups * 600 * 365 / 1e6,
            annualCombinedBudgetMB: binary === null || rollups === null ? null : (binary + rollups * 600) * 365 / 1e6,
            annualCurrentRowsBudgetMB: 288 * 317 * 365 / 1e6,
            assumptions: '317 bytes/raw row from Oct 1 allocation audit; 600 bytes/summary row is unmeasured. Archive table/index/TOAST/checksum overhead excluded. JSON candidate size only; binary codec validates exact numeric roundtrip.' } };
    const text = JSON.stringify(report, null, 2);
    if (output) await writeFile(output, text + '\n', { mode: 0o600 });
    console.log(text);
}
main().catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,12}$/.test(error.code) ? error.code : 'unavailable';
    const safeMessages = ['Archive or billing reconciliation failed', 'Invalid day bounds', 'Too many samples', 'Invalid sample identity/time', 'Nonfinite sample', 'Invalid tariff ID', 'No samples found'];
    const reason = error instanceof Error && safeMessages.includes(error.message) ? error.message : 'details suppressed';
    console.error(`Prototype failed during ${stage} (code: ${code}; ${reason}); connection details suppressed.`);
    process.exitCode = 1;
});
