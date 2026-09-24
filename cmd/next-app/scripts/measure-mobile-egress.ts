import dotenv from 'dotenv';
import type { Pool } from 'pg';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
    EGRESS_SENSITIVITY_SCENARIOS,
    estimateMonthlyEgress,
    estimateJsMappedValueRowsBytes,
    measuredBundlePollingProfiles,
    parseMeasurementArgs,
} from '../src/lib/mobile-egress';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const measurementArgs = parseMeasurementArgs(process.argv.slice(2), new Date());
const devDatabaseUrl = process.env.DEV_DATABASE_URL?.trim();
const guardedSiteId = process.env.EGRESS_SITE_ID?.trim();
if (!devDatabaseUrl) {
    console.error('DEV_DATABASE_URL is required. No database connection was opened.');
    process.exitCode = 1;
} else if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run an egress measurement when NODE_ENV=production. No database connection was opened.');
    process.exitCode = 1;
} else if (!guardedSiteId) {
    console.error('EGRESS_SITE_ID is required. No database connection was opened.');
    process.exitCode = 1;
} else if (!measurementArgs.ok) {
    console.error('Usage: EGRESS_SITE_ID=<id> npx tsx scripts/measure-mobile-egress.ts [--site <id>] [--at <ISO timestamp>]');
    console.error(`${measurementArgs.error} No database connection was opened.`);
    process.exitCode = 1;
} else if (measurementArgs.siteId !== guardedSiteId) {
    console.error('The requested site must match EGRESS_SITE_ID. No database connection was opened.');
    process.exitCode = 1;
} else {
    process.env.DATABASE_URL = devDatabaseUrl;
    void startMeasurement(measurementArgs).catch((error: unknown) => {
        console.error(`Measurement failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}

interface QueryMeasurement {
    query: string;
    rowCount: number;
    mappedValueBytes: number;
    durationMs: number;
}

interface SiteMeasurementContext {
    userId: string;
    timezone: string;
    billingStartDay: number;
}

interface MeasurementRun {
    measurements: QueryMeasurement[];
    querySetValueBytes: number;
}

interface MeasurementRow {
    id: string;
    timezone: string;
    billing_start_day: number;
    user_id: string | null;
}

function localDateString(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find(candidate => candidate.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
}

function cycleDay(localDate: string, cycleStart: Date, timezone: string): number {
    const localCycleDate = localDateString(cycleStart, timezone);
    const utcDay = (value: string): number => Date.parse(`${value}T00:00:00.000Z`);
    return Math.floor((utcDay(localDate) - utcDay(localCycleDate)) / 86_400_000) + 1;
}

function printMeasurement(measurement: QueryMeasurement): void {
    console.log(
        `  ${measurement.query}: ${measurement.rowCount} rows, ` +
        `~${measurement.mappedValueBytes} JS-mapped result-value bytes, ${measurement.durationMs.toFixed(1)} ms`
    );
}

async function startMeasurement(args: Extract<typeof measurementArgs, { ok: true }>): Promise<void> {
    let pool: Pool | undefined;
    try {
        const db = await import('../src/lib/db');
        pool = db.pool;
        await measure(args.siteId, args.asOf, args.historical, pool);
    } catch (error) {
        console.error(`Measurement failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    } finally {
        if (pool) {
            try {
                await pool.end();
            } catch (error) {
                console.error(`Failed to close the database pool: ${error instanceof Error ? error.message : String(error)}`);
                process.exitCode = 1;
            }
        }
    }
}

async function measure(siteId: string, now: Date, historical: boolean, pool: Pool): Promise<void> {
    const { EnergyRepo } = await import('../src/lib/energy-repo');
    const { TariffRepo } = await import('../src/lib/tariff-repo');
    const { getCurrentCycleStart } = await import('../src/lib/billing-cycle');

    const energyRepo = new EnergyRepo();
    const tariffRepo = new TariffRepo();
    const siteQueryStart = performance.now();
    const siteMetadata = await pool.query<MeasurementRow>(
        'SELECT id, user_id, timezone, billing_start_day FROM "Site" WHERE id = $1',
        [siteId]
    );
    const siteQueryDurationMs = performance.now() - siteQueryStart;
    const site = siteMetadata.rows[0];
    if (!site) throw new Error(`Site ${siteId} was not found in the development database.`);
    if (!site.user_id) throw new Error(`Site ${siteId} has no linked user for the active-user lookup.`);

    const context: SiteMeasurementContext = {
        userId: site.user_id,
        timezone: site.timezone,
        billingStartDay: Number(site.billing_start_day),
    };
    const todayStart = EnergyRepo.getSiteMidnight(now, context.timezone);
    const cycleStart = getCurrentCycleStart(context.billingStartDay, now, context.timezone);
    const liveWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const localDate = localDateString(now, context.timezone);

    console.log(`Guarded development site (${context.timezone})`);
    console.log(`Measurement as of: ${now.toISOString()}${historical ? ' (requested historical snapshot)' : ''}`);
    console.log(`Site-local date: ${localDate}; billing cycle day: ${cycleDay(localDate, cycleStart, context.timezone)}`);
    console.log('Byte values are UTF-8 lengths after repository mapping in JavaScript, not raw PostgreSQL text bytes.');
    console.log('Date, numeric, and null conversions can differ from raw driver values; PostgreSQL framing and HTTP/JSON overhead are excluded.');
    console.log(
        `Setup site metadata query: ${siteMetadata.rows.length} row(s), ` +
        `~${estimateJsMappedValueRowsBytes(siteMetadata.rows.map(row => ({
            id: row.id,
            timezone: row.timezone,
            billing_start_day: row.billing_start_day,
            user_id: row.user_id,
        })))} JS-mapped bytes, ${siteQueryDurationMs.toFixed(1)} ms`
    );
    console.log('Snapshot bounds the energy windows; site config, tariff/schedule versions, and user auth state are read as currently stored.');

    const runs: MeasurementRun[] = [];
    for (const label of ['first pass', 'repeat pass'] as const) {
        const measurements: QueryMeasurement[] = [];
        const add = async <T>(
            query: string,
            operation: () => Promise<T[]>,
            toRows: (rows: T[]) => Array<Record<string, string | number | bigint | boolean | Date | null | undefined>>
        ): Promise<T[]> => {
            const start = performance.now();
            const rows = await operation();
            const durationMs = performance.now() - start;
            const mappedValueBytes = estimateJsMappedValueRowsBytes(toRows(rows));
            const measurement = { query, rowCount: rows.length, mappedValueBytes, durationMs };
            measurements.push(measurement);
            printMeasurement(measurement);
            return rows;
        };

        console.log(`\n${label.toUpperCase()}`);
        await add(
            'existing live 24h buckets',
            () => energyRepo.getBucketedEnergyData(siteId, liveWindowStart, now),
            rows => rows.map(row => ({
                timestamp: row.timestamp,
                sample_timestamp: row.sample_timestamp,
                site_id: row.site_id,
                tariff_id: row.tariff_id,
                tariff_schedule_id: row.tariff_schedule_id,
                sample_count: row.sample_count,
                load_power: row.load_power,
                solar_power: row.solar_power,
                grid_power: row.grid_power,
                battery_power: row.battery_power,
                battery_soc: null,
                id: row.id,
            }))
        );
        await add(
            'completed-cycle aggregates',
            () => energyRepo.getCycleAggregates(siteId, cycleStart, todayStart),
            rows => rows.map(row => ({
                day: row.day,
                tariff_id: row.tariff_id,
                tariff_schedule_id: row.tariff_schedule_id,
                load_power: row.load_power,
                solar_power: row.solar_power,
                grid_power: row.grid_power,
                battery_power: row.battery_power,
            }))
        );

        await add(
            "today's raw energy rows",
            () => energyRepo.getRawEnergyData(siteId, todayStart, now),
            rows => rows.map(row => ({
                site_id: row.site_id,
                timestamp: row.timestamp,
                tariff_id: row.tariff_id,
                tariff_schedule_id: row.tariff_schedule_id,
                load_power: row.load_power,
                solar_power: row.solar_power,
                grid_power: row.grid_power,
                battery_power: row.battery_power,
                battery_soc: row.battery_soc,
            }))
        );

        await add(
            'latest energy row',
            async () => {
                const row = await energyRepo.getLatestEnergyData(siteId, now);
                return row ? [row] : [];
            },
            rows => rows.map(row => ({
                timestamp: row.timestamp,
                battery_soc: row.batterySoc,
                battery_power: row.batteryPower,
                solar_power: row.solarPower,
                grid_power: row.gridPower,
                load_power: row.loadPower,
            }))
        );

        await add(
            'tariff versions',
            () => tariffRepo.getTariffsForSite(siteId),
            rows => rows.map(row => ({ id: row.id, site_id: row.site_id, name: row.name, updated: row.updated }))
        );

        await add(
            'schedule versions',
            () => tariffRepo.getSchedulesForSite(siteId),
            rows => rows.map(row => ({
                id: row.id,
                season_id: row.season_id,
                name: row.name,
                buy_rate: row.buy_rate,
                sell_rate: row.sell_rate,
                from_day_of_week: row.from_day_of_week,
                from_hour: row.from_hour,
                from_minute: row.from_minute,
                to_day_of_week: row.to_day_of_week,
                to_hour: row.to_hour,
                to_minute: row.to_minute,
            }))
        );

        await add(
            'active-user auth lookup',
            async () => {
                const result = await pool.query<{ is_active: boolean }>(
                    'SELECT is_active FROM "User" WHERE id = $1',
                    [context.userId]
                );
                return result.rows;
            },
            rows => rows.map(row => ({ is_active: row.is_active }))
        );

        runs.push({
            measurements,
            querySetValueBytes: measurements.reduce((sum, item) => sum + item.mappedValueBytes, 0),
        });
        console.log(`  Total JS-mapped value proxy for this query set: ~${runs[runs.length - 1].querySetValueBytes} bytes`);
    }

    const capBytes = 5_000_000_000;
    const repeatedValueBytes = runs[1].querySetValueBytes;
    console.log('\nMonthly request and egress sensitivity (30 days; repeat-pass JS-mapped proxy; 5 GB = 5,000,000,000 bytes)');
    console.log('Each case applies the full measured query bundle to every request; this is a comparison scenario, not a trace of each route.');
    console.log('Sensitivity multipliers are illustrative margins, not measured confidence bounds.');
    for (const profile of measuredBundlePollingProfiles) {
        console.log(`\n${profile.name} (${profile.intervalMinutes}-minute interval; full-bundle scenario)`);
        console.log('active h/day | phones | req/month | proxy GB (% cap) | +50% GB (% cap) | +100% GB (% cap)');
        for (const activeHoursPerDay of [1, 8, 24]) {
            for (const phones of [1, 2, 10]) {
                const estimates = EGRESS_SENSITIVITY_SCENARIOS.map(scenario => estimateMonthlyEgress({
                    bytesPerPoll: repeatedValueBytes * scenario.multiplier,
                    intervalMinutes: profile.intervalMinutes,
                    activeHoursPerDay,
                    phones,
                }));
                const format = (bytesPerMonth: number): string =>
                    `${(bytesPerMonth / 1_000_000_000).toFixed(4)} (${((bytesPerMonth / capBytes) * 100).toFixed(2)}%)`;
                console.log(
                    `${String(activeHoursPerDay).padStart(12)} | ${String(phones).padStart(6)} | ` +
                    `${String(estimates[0].requestsPerMonth).padStart(9)} | ` +
                    `${format(estimates[0].bytesPerMonth).padStart(20)} | ` +
                    `${format(estimates[1].bytesPerMonth).padStart(17)} | ` +
                    `${format(estimates[2].bytesPerMonth).padStart(18)}`
                );
            }
        }
    }
}
