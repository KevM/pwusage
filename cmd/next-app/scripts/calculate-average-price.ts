import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load env before importing db
loadEnvConfig(path.resolve(__dirname, '../'));

async function main() {
    const { pool } = await import('../src/lib/db');
    const { SiteRepo } = await import('../src/lib/site-repo');
    const { TariffRepo } = await import('../src/lib/tariff-repo');
    const { Schedule } = await import('../src/lib/schedule');
    const { getCurrentCycleStart, getNextCycleStart } = await import('../src/lib/billing-cycle');
    const { EnergyRepo } = await import('../src/lib/energy-repo');

    console.log('Finding candidate sites with tariffs and energy data...');
    const candidateSitesQuery = await pool.query(`
        SELECT DISTINCT s.id, s.name, s.timezone, s.billing_start_day
        FROM "Site" s
        JOIN "Tariff" t ON t.site_id = s.id AND t.is_current = true
        JOIN "EnergyData" ed ON ed.site_id = s.id
        LIMIT 5
    `);

    if (candidateSitesQuery.rows.length === 0) {
        console.log('No sites with current tariffs and energy data found.');
        process.exit(0);
    }

    // Let's analyze all candidate sites that have data
    for (const targetSiteRow of candidateSitesQuery.rows) {
        console.log('\n======================================================');
        console.log(`ANALYZING SITE: ${targetSiteRow.name} (ID: ${targetSiteRow.id})`);
        console.log('======================================================');

        const siteRepo = new SiteRepo();
        const site = await siteRepo.getSite(targetSiteRow.id);
        if (!site) {
            console.error(`Could not load site details for ${targetSiteRow.id}.`);
            continue;
        }

        const tariffRepo = new TariffRepo();
        const allSchedules = await tariffRepo.getSchedulesForSite(site.id);

        const scheduleMap = new Map<number, any>();
        site.tariffs.forEach(t => {
            if (t.seasons) {
                t.seasons.forEach(season => {
                    if (season.schedules) {
                        season.schedules.forEach(s => scheduleMap.set(s.id, s));
                    }
                });
            }
        });
        allSchedules.forEach(s => scheduleMap.set(s.id, s));

        const schedule = new Schedule(site.tariffs, site.timezone);
        const energyRepo = new EnergyRepo();

        const latestTs = await energyRepo.getLatestTimestamp(site.id);
        if (!latestTs) {
            console.log('No energy data found for this site.');
            continue;
        }
        console.log(`Latest energy data timestamp: ${latestTs.toString()}`);

        // Get current billing cycle start
        const cycleStart = getCurrentCycleStart(site.billing_start_day, latestTs, site.timezone);
        const cycleEnd = getNextCycleStart(site.billing_start_day, cycleStart, site.timezone);

        console.log(`Billing cycle: ${cycleStart.toISOString()} to ${cycleEnd.toISOString()}`);

        // Fetch raw energy data for the cycle
        const rows = await energyRepo.getRawEnergyData(site.id, cycleStart, latestTs < cycleEnd ? latestTs : cycleEnd);
        console.log(`Fetched ${rows.length} rows of raw energy data.`);

        if (rows.length === 0) {
            console.log('No energy data in the current billing cycle range.');
            continue;
        }

        // METHOD A: Interval-level Resolution (no netting)
        let totalImportKwh = 0;
        let totalImportCost = 0;
        let totalExportKwh = 0;
        let totalExportCredit = 0;
        let totalHomeKwh = 0;
        let totalSolarKwh = 0;

        // METHOD B: Netted-level Resolution (accumulate net grid per TOU period, then price)
        // Key: tariff_id | touName | buy_rate | sell_rate
        const touAggregation = new Map<string, {
            name: string;
            buyRate: number;
            sellRate: number;
            gridWh: number;
            homeWh: number;
            solarWh: number;
        }>();

        for (const row of rows) {
            let buyRate = 0;
            let sellRate = 0;
            let touName = 'Standard';

            if (row.tariff_schedule_id != null) {
                const sched = scheduleMap.get(row.tariff_schedule_id);
                if (sched) {
                    touName = sched.name || 'Standard';
                    buyRate = sched.buy_rate || 0;
                    sellRate = sched.sell_rate || 0;
                }
            } else {
                const tp = schedule.getTariffPeriod(row.timestamp);
                if (tp) {
                    touName = tp.schedule.name || 'Standard';
                    buyRate = tp.schedule.buy_rate || 0;
                    sellRate = tp.schedule.sell_rate || 0;
                }
            }

            const homeKwh = row.load_power / 1000;
            const solarKwh = row.solar_power / 1000;

            totalHomeKwh += homeKwh;
            totalSolarKwh += solarKwh;

            // Interval import/export (Method A)
            if (row.grid_power > 0) {
                const importKwh = row.grid_power / 1000;
                totalImportKwh += importKwh;
                totalImportCost += importKwh * buyRate;
            } else if (row.grid_power < 0) {
                const exportKwh = -row.grid_power / 1000;
                totalExportKwh += exportKwh;
                totalExportCredit += exportKwh * sellRate;
            }

            // Aggregate for Method B
            const key = `${row.tariff_id}|${touName}|${buyRate}|${sellRate}`;
            let agg = touAggregation.get(key);
            if (!agg) {
                agg = {
                    name: touName,
                    buyRate,
                    sellRate,
                    gridWh: 0,
                    homeWh: 0,
                    solarWh: 0
                };
                touAggregation.set(key, agg);
            }
            agg.gridWh += row.grid_power;
            agg.homeWh += row.load_power;
            agg.solarWh += row.solar_power;
        }

        // Compute Method B costs
        let totalNettedCost = 0;
        let totalNettedImportKwh = 0;
        let totalNettedExportKwh = 0;
        let totalNettedImportCost = 0;
        let totalNettedExportCredit = 0;

        for (const agg of touAggregation.values()) {
            const gridKwh = agg.gridWh / 1000;
            if (gridKwh >= 0) {
                const cost = gridKwh * agg.buyRate;
                totalNettedImportKwh += gridKwh;
                totalNettedImportCost += cost;
                totalNettedCost += cost;
            } else {
                const credit = -gridKwh * agg.sellRate;
                totalNettedExportKwh += -gridKwh;
                totalNettedExportCredit += credit;
                totalNettedCost -= credit;
            }
        }

        const avgGridImportPriceA = totalImportKwh > 0 ? (totalImportCost / totalImportKwh) : 0;
        const avgGridExportPriceA = totalExportKwh > 0 ? (totalExportCredit / totalExportKwh) : 0;
        const avgHomeConsumptionPriceA = totalHomeKwh > 0 ? ((totalImportCost - totalExportCredit) / totalHomeKwh) : 0;

        const avgGridImportPriceB = totalNettedImportKwh > 0 ? (totalNettedImportCost / totalNettedImportKwh) : 0;
        const avgGridExportPriceB = totalNettedExportKwh > 0 ? (totalNettedExportCredit / totalNettedExportKwh) : 0;
        const avgHomeConsumptionPriceB = totalHomeKwh > 0 ? (totalNettedCost / totalHomeKwh) : 0;

        console.log(`\n--- Metric Comparison ---`);
        console.log(`Home Consumption:  ${totalHomeKwh.toFixed(2)} kWh`);
        console.log(`Solar Production:  ${totalSolarKwh.toFixed(2)} kWh`);
        console.log(`\n[Method A: Interval-level Resolution]`);
        console.log(`  Grid Imported:   ${totalImportKwh.toFixed(2)} kWh ($${totalImportCost.toFixed(2)})`);
        console.log(`  Grid Exported:   ${totalExportKwh.toFixed(2)} kWh ($${totalExportCredit.toFixed(2)})`);
        console.log(`  Net Grid Bill:   $${(totalImportCost - totalExportCredit).toFixed(2)}`);
        console.log(`  Avg Import Price: $${avgGridImportPriceA.toFixed(4)} / kWh`);
        console.log(`  Avg Export Rate:  $${avgGridExportPriceA.toFixed(4)} / kWh`);
        console.log(`  Effective Consumption Cost: $${avgHomeConsumptionPriceA.toFixed(4)} / kWh`);

        console.log(`\n[Method B: TOU-Period Netting (Current App Behavior)]`);
        console.log(`  Grid Imported (Netted): ${totalNettedImportKwh.toFixed(2)} kWh ($${totalNettedImportCost.toFixed(2)})`);
        console.log(`  Grid Exported (Netted): ${totalNettedExportKwh.toFixed(2)} kWh ($${totalNettedExportCredit.toFixed(2)})`);
        console.log(`  Net Grid Bill:   $${totalNettedCost.toFixed(2)}`);
        console.log(`  Avg Import Price: $${avgGridImportPriceB.toFixed(4)} / kWh`);
        console.log(`  Avg Export Rate:  $${avgGridExportPriceB.toFixed(4)} / kWh`);
        console.log(`  Effective Consumption Cost: $${avgHomeConsumptionPriceB.toFixed(4)} / kWh`);

        console.log(`\n[Difference Analysis]`);
        const billDiff = (totalImportCost - totalExportCredit) - totalNettedCost;
        console.log(`  Bill Difference (Interval - Netted): $${billDiff.toFixed(2)}`);
        console.log(`  (A negative difference means interval-level billing is cheaper than TOU netting)`);
    }
}

main().catch(console.error).finally(() => process.exit(0));
