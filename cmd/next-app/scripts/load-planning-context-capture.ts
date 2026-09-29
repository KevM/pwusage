/**
 * Diagnose why the mobile household profile is unavailable for a site.
 *
 * Runs the same query and the same `buildLoadPlanningContext` the
 * `/api/mobile/load-planning-context` route runs, then prints the diagnostics the
 * route swallows: row counts, per-day coverage, timestamp alignment, and which
 * gate rejected the profile. Safe to run against production data: it prints no
 * site name, no credentials, and no per-interval values.
 *
 * Usage: npx tsx scripts/load-planning-context-capture.ts <siteId> [--json]
 */
import 'dotenv/config';
import { Temporal } from '@js-temporal/polyfill';
import { pool } from '../src/lib/db';
import { buildLoadPlanningContext } from '../src/lib/load-planning-context';

const HISTORY_DAYS = 14;
const MINIMUM_COVERAGE = 0.9;
const MINIMUM_DAY_SAMPLES = 5;

interface EnergyRow {
    timestamp: Date;
    load_power: number;
    battery_power: number;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const asJson = args.includes('--json');
    const siteId = args.find((arg) => !arg.startsWith('--'));
    if (!siteId) {
        console.error('Usage: npx tsx scripts/load-planning-context-capture.ts <siteId> [--json]');
        process.exit(1);
    }

    const { rows: siteRows } = await pool.query('SELECT timezone FROM "Site" WHERE id = $1', [siteId]);
    const timeZone = siteRows[0]?.timezone as string | undefined;
    if (!timeZone) {
        console.error(`No site found for that id (timezones: ${JSON.stringify(siteRows.map((row) => row.timezone))}).`);
        process.exit(1);
    }

    const asOf = new Date();
    const endDate = Temporal.Instant.from(asOf.toISOString())
        .toZonedDateTimeISO(timeZone)
        .toPlainDate();
    const startDate = endDate.subtract({ days: HISTORY_DAYS });
    const historyEnd = new Date(endDate.toZonedDateTime({ timeZone }).epochMilliseconds);
    const historyStart = new Date(startDate.toZonedDateTime({ timeZone }).epochMilliseconds);

    const { rows } = await pool.query<EnergyRow>(
        `SELECT timestamp, load_power, battery_power FROM "EnergyData"
         WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3
         ORDER BY timestamp ASC`,
        [siteId, historyStart, historyEnd]
    );

    const context = buildLoadPlanningContext(
        rows.map((row) => ({
            timestamp: new Date(row.timestamp),
            site_id: siteId,
            tariff_id: 0,
            tariff_schedule_id: 0,
            load_power: Number(row.load_power),
            solar_power: 0,
            grid_power: 0,
            battery_power: Number(row.battery_power),
            battery_soc: null,
        })),
        timeZone,
        asOf
    );

    // Per-day coverage over the same window, which is what the 90% gate sees.
    const perDay = new Map<string, number>();
    for (const row of rows) {
        const day = Temporal.Instant.from(new Date(row.timestamp).toISOString())
            .toZonedDateTimeISO(timeZone)
            .toPlainDate();
        const key = day.toString();
        perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    const expectedPerDay = 24 * 12;
    const days = [...perDay.entries()]
        .map(([day, count]) => ({ day, count, coverage: count / expectedPerDay }))
        .sort((a, b) => (a.day < b.day ? 1 : -1));

    const seconds = (row: EnergyRow) =>
        Temporal.Instant.from(new Date(row.timestamp).toISOString()).epochMilliseconds / 1000 % 60;
    const offGrid = rows.filter((row) => Math.abs(seconds(row)) > 0.5).length;
    const nonFinite = rows.filter(
        (row) => !Number.isFinite(Number(row.load_power)) || !Number.isFinite(Number(row.battery_power))
    ).length;

    const report = {
        siteIdSuffix: siteId.slice(-4),
        timeZone,
        windowStart: historyStart.toISOString(),
        windowEnd: historyEnd.toISOString(),
        rowCount: rows.length,
        expectedRows: HISTORY_DAYS * expectedPerDay,
        usableDayCount: context.usableDayCount,
        availability: context.availability,
        unavailableReason: context.unavailableReason ?? null,
        distinctDaysWithData: days.length,
        daysBelowCoverage: days.filter((day) => day.coverage < MINIMUM_COVERAGE).map((day) => day.day),
        offGridTimestampCount: offGrid,
        nonFiniteValueCount: nonFinite,
        days,
    };

    if (asJson) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    console.log(`site .........${report.siteIdSuffix} (${timeZone})`);
    console.log(`window .......${report.windowStart} -> ${report.windowEnd}`);
    console.log(`rows .........${report.rowCount} of ${report.expectedRows} expected`);
    console.log(`availability ..${report.availability}${report.unavailableReason ? ` (${report.unavailableReason})` : ''}`);
    console.log(`usable days ..${report.usableDayCount} (need ${MINIMUM_DAY_SAMPLES} at >= ${MINIMUM_COVERAGE * 100}% coverage)`);
    console.log(`off-grid ts ..${offGrid} rows not on a whole minute`);
    console.log(`non-finite ...${nonFinite} rows`);
    console.log('');
    for (const day of days) {
        const flag = day.coverage >= MINIMUM_COVERAGE ? '  ' : '  <-- below gate';
        console.log(`  ${day.day}  ${String(day.count).padStart(3)} rows  ${(day.coverage * 100).toFixed(1)}%${flag}`);
    }
    if (context.availability === 'unavailable') {
        console.log('');
        console.log('The profile is gated on the most recent window only, so older history does not help.');
    }
}

main()
    .catch((error) => {
        console.error('Capture failed:', error);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
