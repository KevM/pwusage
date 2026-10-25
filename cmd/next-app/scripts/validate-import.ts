
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Load Env
function loadEnv(filepath: string) {
    try {
        const content = fs.readFileSync(filepath, 'utf8');
        content.split('\n').forEach(line => {
            const [key, ...vals] = line.split('=');
            if (key && vals.length) {
                const val = vals.join('=').trim().replace(/^['"]|['"]$/g, '');
                if (!process.env[key.trim()]) process.env[key.trim()] = val;
            }
        });
    } catch (e) { }
}
loadEnv(path.resolve(__dirname, '../.env.local'));
loadEnv(path.resolve(__dirname, '../.env'));

async function main() {
    // Dynamic import to avoid initialization order issues
    const { createTeslaClientForSite } = await import('../src/lib/tesla-client-factory');
    const { Importer } = await import('../src/lib/importer');
    const { pool } = await import('../src/lib/db');

    const dateArg = process.argv[2];
    const targetDate = dateArg ? new Date(dateArg) : new Date();
    targetDate.setHours(0, 0, 0, 0);
    const endDate = new Date(targetDate);
    // If today, use now as end to capture partial day
    const isToday = new Date().toDateString() === targetDate.toDateString();
    if (isToday) {
        endDate.setTime(new Date().getTime());
    } else {
        endDate.setDate(endDate.getDate() + 1);
    }

    console.log(`\n=== Validate Import Tool ===`);
    console.log(`Target Date: ${targetDate.toLocaleDateString()}`);
    console.log(`Range: ${targetDate.toISOString()} -> ${endDate.toISOString()}\n`);

    // 1. Get Site & Token
    const siteRes = await pool.query('SELECT id, user_id, timezone, name FROM "Site" LIMIT 1');
    const site = siteRes.rows[0];
    if (!site) { console.error('No site found!'); process.exit(1); }
    console.log(`Site: ${site.name} (${site.id})`);

    const client = await createTeslaClientForSite(site.id);
    if (!client) { console.error('No Tesla tokens found!'); process.exit(1); }

    const importer = new Importer(client);

    // 2. Download Raw Data (for inspection)
    console.log(`\n1. Downloading Raw Data from Tesla...`);
    const history = await client.getEnergyHistory(site.id, targetDate, endDate, 'day', site.timezone);
    const rawFilename = `tesla-raw-${targetDate.toISOString().split('T')[0]}.json`;
    fs.writeFileSync(rawFilename, JSON.stringify(history, null, 2));
    console.log(`   Saved ${history.length} raw entries to ${rawFilename}`);

    // Calculate Raw Totals from API Response (for comparison)
    // IMPORTANT: This uses the raw fields directly, mirroring Importer logic manually
    let rawTotalSolar = 0;
    let rawTotalLoad = 0;
    let rawTotalGridImport = 0;
    let rawTotalGridExport = 0;
    let rawTotalBatteryCharge = 0;
    let rawTotalBatteryDischarge = 0;

    history.forEach(h => {
        // Simple summation of key fields
        // Solar: total_solar_generation or solar_energy_exported as fallback
        rawTotalSolar += (h.total_solar_generation || h.solar_energy_exported || 0);
        rawTotalLoad += (h.total_home_usage || 0);

        // Grid
        rawTotalGridImport += (h.grid_energy_imported || 0);
        rawTotalGridExport += (h.total_grid_energy_exported || h.grid_energy_exported_from_solar || 0);
        // Note: total_grid_energy_exported is usually the summary field

        // Battery
        rawTotalBatteryCharge += (h.total_battery_charge || 0);
        rawTotalBatteryDischarge += (h.total_battery_discharge || 0);
    });

    // 3. Run Importer (Force Refresh)
    console.log(`\n2. Running Importer (Force Refresh)...`);
    await importer.ensureDataForRange(site.id, targetDate, endDate, (msg) => process.stdout.write(`   ${msg}\r`), { force: true });
    console.log(`   Import Complete.         `);

    // 4. Query DB for Results
    console.log(`\n3. Querying Database...`);
    // Note: Importer stores values scaled by 1000 sometimes? No, Importer logic:
    // scale = 1 for 5-min intervals (duration < 1h)
    // We assume 5-min intervals here for "Today"

    // We need to query EnergyData and SUM the power column.
    // Wait, EnergyData stores "power" (which for 5-min intervals is Energy in Wh effectively, or Avg Power?)
    // The columns are named `*_power`. 
    // In Importer.ts:
    // solar_power: (h.total_solar_generation ?? 0) * scale
    // If API returns Energy (Wh), then DB stores Energy (Wh).

    // Let's verify scaling.
    // scale = 1.
    // So DB stores Wh.

    // Convert to Site Wall Clock strings for querying TIMESTAMP WITHOUT TIME ZONE
    // This matches EnergyRepo logic and avoids Date object timezone confusion
    const toWallClock = (d: Date, tz: string) => {
        return d.toLocaleString('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).replace(/,/, '');
    };

    const startStr = toWallClock(targetDate, site.timezone);
    const endStr = toWallClock(endDate, site.timezone);

    console.log(`Querying DB with Wall Clock Range: ${startStr} -> ${endStr}`);

    const dbRes = await pool.query(`
        SELECT 
            COUNT(*) as count,
            SUM(solar_power) as solar,
            SUM(load_power) as load,
            SUM(grid_power) as grid,
            SUM(battery_power) as battery
        FROM "EnergyData"
        WHERE site_id = $1 
        AND timestamp >= $2::timestamp 
        AND timestamp < $3::timestamp
    `, [site.id, startStr, endStr]);

    const dbRow = dbRes.rows[0];
    const dbSolar = Number(dbRow.solar || 0);
    const dbLoad = Number(dbRow.load || 0);

    // Grid in DB is Net. Positive = Import? 
    // Importer: grid = gridImported (if > 0) else -gridExported.
    // So Positive = Import, Negative = Export.
    // We can't easily split Import/Export from SUM(grid_power) without checking individual rows
    // Unless we query SUM(CASE WHEN grid_power > 0...)

    const dbSplitRes = await pool.query(`
        SELECT 
            SUM(CASE WHEN grid_power > 0 THEN grid_power ELSE 0 END) as grid_import,
            SUM(CASE WHEN grid_power < 0 THEN grid_power ELSE 0 END) as grid_export,
            SUM(CASE WHEN battery_power > 0 THEN battery_power ELSE 0 END) as batt_charge,
            SUM(CASE WHEN battery_power < 0 THEN battery_power ELSE 0 END) as batt_discharge
        FROM "EnergyData"
        WHERE site_id = $1 
        AND timestamp >= $2 
        AND timestamp < $3
    `, [site.id, targetDate.toISOString(), endDate.toISOString()]);

    const split = dbSplitRes.rows[0];
    const dbGridImport = Number(split.grid_import || 0);
    const dbGridExport = Math.abs(Number(split.grid_export || 0));
    const dbBattCharge = Number(split.batt_charge || 0);
    const dbBattDischarge = Math.abs(Number(split.batt_discharge || 0));

    // 5. Generate Report
    console.log(`\n=== IMPORT REPORT ===`);
    console.log(`DB Row Count: ${dbRes.rows[0].count} (Expected ~${history.length})`);
    console.log(`Metric           | Raw API Sum (Wh) | Database Sum (Wh) | Delta`);
    console.log(`-----------------|------------------|-------------------|-------`);

    const printRow = (label: string, raw: number, dbVal: number) => {
        const delta = dbVal - raw;
        console.log(`${label.padEnd(16)} | ${raw.toFixed(1).padEnd(16)} | ${dbVal.toFixed(1).padEnd(17)} | ${delta.toFixed(1)}`);
    };

    printRow('Solar Gen', rawTotalSolar, dbSolar);
    printRow('Home Load', rawTotalLoad, dbLoad);
    printRow('Grid Import', rawTotalGridImport, dbGridImport);
    // Note: Raw Grid Export might differ if Importer uses 'Net' logic per interval vs Raw totals
    printRow('Grid Export', rawTotalGridExport, dbGridExport);
    printRow('Batt Charge', rawTotalBatteryCharge, dbBattCharge);
    printRow('Batt Discharge', rawTotalBatteryDischarge, dbBattDischarge);

    console.log(`\n(Raw API file saved to: ${rawFilename})`);
    console.log(`Note: 'Raw API Sum' is a simple sum of history fields. 'Database Sum' is what the Importer logic produced.`);

    await pool.end();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
