/**
 * validate-aggregation.ts
 *
 * Smoke-test: runs both the old full-cycle raw approach and the new
 * split (priorAggregates + todayRaw) approach for every site and compares
 * per-TOU totals. Any mismatch is flagged with a clear diff.
 *
 * Usage:
 *   npx tsx scripts/validate-aggregation.ts
 *   npx tsx scripts/validate-aggregation.ts --site=2252268092126997   # single site
 */

import 'dotenv/config';
import { pool } from '../src/lib/db';
import { EnergyRepo } from '../src/lib/energy-repo';
import { Schedule } from '../src/lib/schedule';
import { wattsToKilowatts } from '../src/lib/energy-utils';
import type { SiteWithTariffs, TariffSchedule } from '../src/lib/db';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const siteFilter = process.argv.find(a => a.startsWith('--site='))?.split('=')[1];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TouBucket {
    tariffName: string;
    touName: string;
    loadKwh: number;
    gridKwh: number;
    solarKwh: number;
    batteryKwh: number;
}

type BucketMap = Map<string, TouBucket>;

// ---------------------------------------------------------------------------
// Old approach: full cycle raw → JS aggregation using Schedule.getTariffPeriod
// ---------------------------------------------------------------------------
async function oldApproach(repo: EnergyRepo, site: SiteWithTariffs, start: Date, now: Date): Promise<BucketMap> {
    const rows = await repo.getRawEnergyData(site.id, start, now);
    const schedule = new Schedule(site.tariffs, site.timezone);
    const tariffMap = new Map(site.tariffs.map(t => [t.id, t]));

    const buckets: BucketMap = new Map();
    for (const row of rows) {
        const tp = schedule.getTariffPeriod(row.timestamp);
        const tariffName = tp ? (tp.tariff.name ?? 'Unknown') : (tariffMap.get(row.tariff_id)?.name ?? 'Unknown');
        const touName = tp ? (tp.schedule.name ?? 'Standard') : 'Unknown';
        const key = `${tariffName}|${touName}`;

        let b = buckets.get(key);
        if (!b) {
            b = { tariffName, touName, loadKwh: 0, gridKwh: 0, solarKwh: 0, batteryKwh: 0 };
            buckets.set(key, b);
        }
        b.loadKwh    += wattsToKilowatts(row.load_power);
        b.gridKwh    += wattsToKilowatts(row.grid_power);
        b.solarKwh   += wattsToKilowatts(row.solar_power);
        b.batteryKwh += wattsToKilowatts(row.battery_power);
    }
    return buckets;
}

// ---------------------------------------------------------------------------
// New approach: priorAggregates + todayRaw
// ---------------------------------------------------------------------------
async function newApproach(repo: EnergyRepo, site: SiteWithTariffs, start: Date, todayStart: Date, now: Date): Promise<BucketMap> {
    const [priorAggregates, todayRaw] = await Promise.all([
        repo.getCycleAggregates(site.id, start, todayStart),
        repo.getRawEnergyData(site.id, todayStart, now),
    ]);

    const schedule = new Schedule(site.tariffs, site.timezone);
    const tariffMap = new Map(site.tariffs.map(t => [t.id, t]));

    // Build a flat map of schedule_id → TariffSchedule for the prior aggregate lookup
    const scheduleMap = new Map<number, TariffSchedule>();
    site.tariffs.forEach(t => {
        t.seasons?.forEach(s => s.schedules?.forEach(sc => scheduleMap.set(sc.id, sc)));
    });

    const buckets: BucketMap = new Map();

    const upsert = (tariffName: string, touName: string, row: { load_power: number; grid_power: number; solar_power: number; battery_power: number }) => {
        const key = `${tariffName}|${touName}`;
        let b = buckets.get(key);
        if (!b) {
            b = { tariffName, touName, loadKwh: 0, gridKwh: 0, solarKwh: 0, batteryKwh: 0 };
            buckets.set(key, b);
        }
        b.loadKwh    += wattsToKilowatts(row.load_power);
        b.gridKwh    += wattsToKilowatts(row.grid_power);
        b.solarKwh   += wattsToKilowatts(row.solar_power);
        b.batteryKwh += wattsToKilowatts(row.battery_power);
    };

    // Pass 1: Prior aggregates (schedule_id already stamped)
    for (const row of priorAggregates) {
        const tariffName = tariffMap.get(row.tariff_id)?.name ?? 'Unknown';
        let touName = 'Unknown';
        if (row.tariff_schedule_id !== null) {
            const sched = scheduleMap.get(row.tariff_schedule_id);
            if (sched) touName = sched.name ?? 'Standard';
        }
        upsert(tariffName, touName, row);
    }

    // Pass 2: Today raw (same per-row schedule lookup as old path)
    for (const row of todayRaw) {
        const tp = schedule.getTariffPeriod(row.timestamp);
        const tariffName = tp ? (tp.tariff.name ?? 'Unknown') : (tariffMap.get(row.tariff_id)?.name ?? 'Unknown');
        const touName = tp ? (tp.schedule.name ?? 'Standard') : 'Unknown';
        upsert(tariffName, touName, row);
    }

    return buckets;
}

// ---------------------------------------------------------------------------
// Compare two BucketMaps
// ---------------------------------------------------------------------------
const TOLERANCE_KWH = 0.001; // floating point rounding tolerance

interface CompareResult {
    match: boolean;
    diffs: string[];
    oldRowCount?: number;
    newPriorCount?: number;
    newTodayCount?: number;
}

function compareBuckets(oldB: BucketMap, newB: BucketMap): CompareResult {
    const diffs: string[] = [];
    const allKeys = new Set([...oldB.keys(), ...newB.keys()]);

    for (const key of allKeys) {
        const o = oldB.get(key);
        const n = newB.get(key);

        if (!o) { diffs.push(`  + NEW bucket only in new: ${key} (load=${n!.loadKwh.toFixed(3)} kWh)`); continue; }
        if (!n) { diffs.push(`  - OLD bucket only in old: ${key} (load=${o.loadKwh.toFixed(3)} kWh)`); continue; }

        const fields: Array<[string, number, number]> = [
            ['load',    o.loadKwh,    n.loadKwh],
            ['grid',    o.gridKwh,    n.gridKwh],
            ['solar',   o.solarKwh,   n.solarKwh],
            ['battery', o.batteryKwh, n.batteryKwh],
        ];
        for (const [field, oldVal, newVal] of fields) {
            if (Math.abs(oldVal - newVal) > TOLERANCE_KWH) {
                diffs.push(`  ${key} [${field}]: old=${oldVal.toFixed(4)} new=${newVal.toFixed(4)} delta=${(newVal - oldVal).toFixed(4)}`);
            }
        }
    }

    return { match: diffs.length === 0, diffs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const repo = new EnergyRepo();
    const now = new Date();

    // Determine site IDs to test
    let siteIds: string[];
    if (siteFilter) {
        siteIds = [siteFilter];
    } else {
        siteIds = await repo.getSiteIds();
    }

    console.log(`\nValidating aggregation for ${siteIds.length} site(s) at ${now.toISOString()}\n${'─'.repeat(72)}`);

    let passCount = 0;
    let failCount = 0;
    let skipCount = 0;

    for (const siteId of siteIds) {
        const site = await repo.getSite(siteId);
        if (!site) { console.log(`[${siteId}] SKIP — site not found`); skipCount++; continue; }

        // Compute billing start (same logic as route.ts)
        const siteLocalNowStr = now.toLocaleString('en-US', { timeZone: site.timezone, year: 'numeric', month: 'numeric', day: 'numeric' });
        const [mStr, dStr, yStr] = siteLocalNowStr.split('/');
        const siteYear = parseInt(yStr), siteMonth = parseInt(mStr) - 1, siteDate = parseInt(dStr);
        const billingStartDay = site.billing_start_day || 1;
        let billingYear = siteYear, billingMonth = siteMonth;
        if (siteDate < billingStartDay) {
            billingMonth -= 1;
            if (billingMonth < 0) { billingMonth = 11; billingYear -= 1; }
        }
        const billingStartPivot = new Date(Date.UTC(billingYear, billingMonth, billingStartDay, 12, 0, 0));
        const start = EnergyRepo.getSiteMidnight(billingStartPivot, site.timezone);
        const todayStart = EnergyRepo.getSiteMidnight(now, site.timezone);

        // Skip sites with no data in this cycle
        const hasData = await repo.hasData(siteId);
        if (!hasData) { console.log(`[${site.name ?? siteId}] SKIP — no energy data`); skipCount++; continue; }

        const t0 = Date.now();
        const [oldBuckets, newBuckets] = await Promise.all([
            oldApproach(repo, site, start, now),
            newApproach(repo, site, start, todayStart, now),
        ]);
        const elapsed = Date.now() - t0;

        const result = compareBuckets(oldBuckets, newBuckets);

        const oldTotal = [...oldBuckets.values()].reduce((s, b) => s + b.loadKwh, 0);
        const newTotal = [...newBuckets.values()].reduce((s, b) => s + b.loadKwh, 0);

        if (result.match) {
            console.log(`✅ PASS  ${(site.name ?? siteId).padEnd(30)} buckets=${oldBuckets.size}  totalLoad=${oldTotal.toFixed(2)} kWh  (${elapsed}ms)`);
            passCount++;
        } else {
            console.log(`❌ FAIL  ${site.name ?? siteId}`);
            console.log(`         old_load=${oldTotal.toFixed(4)} kWh  new_load=${newTotal.toFixed(4)} kWh`);
            result.diffs.forEach(d => console.log(d));
            failCount++;
        }
    }

    console.log(`\n${'─'.repeat(72)}`);
    console.log(`Results: ${passCount} passed, ${failCount} failed, ${skipCount} skipped\n`);

    await pool.end();
    if (failCount > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
