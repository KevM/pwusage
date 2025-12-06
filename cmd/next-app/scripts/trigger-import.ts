
import { TeslaClient } from '../src/lib/tesla-client';
import { Importer } from '../src/lib/importer';
import { db } from '../src/lib/db';

async function main() {
    const siteId = '2252268092126997';
    console.log(`Forcing import for site ${siteId}...`);

    // Mock client that returns the file content we saved (or just let it hit the real API if tokens are there?)
    // The real API is safer if we want real data, but we can also just rely on the fact that we cleared the JSON in DB
    // so ensureSite will fetch it again.

    // We need a client with tokens. SettingsRepo?
    // Let's just use the existing classes.

    const { SettingsRepo } = await import('../src/lib/settings-repo');
    const settings = new SettingsRepo();
    const token = settings.getAccessToken();
    const refresh = settings.getRefreshToken();

    if (!token) {
        console.error('No token found');
        process.exit(1);
    }

    const client = new TeslaClient({
        accessToken: token,
        refreshToken: refresh,
        onTokenUpdate: (a, r) => {
            settings.setAccessToken(a);
            settings.setRefreshToken(r);
        }
    });

    const importer = new Importer(client);

    // Force update by clearing JSON first
    db.prepare("UPDATE Site SET json = '{}' WHERE id = ?").run(siteId);

    // Delete old tariffs to force clean slate (this will delete EnergyData too due to FK)
    console.log('Deleting old tariffs and energy data...');
    db.prepare("DELETE FROM Tariff WHERE site_id = ?").run(siteId);

    console.log('Ensuring site and tariffs...');
    await importer.ensureSite(siteId);

    console.log('Importing energy data (this may take a while)...');
    // Import last 7 days for testing
    // We need to manually call loadInterval or just let importSite do its thing?
    // importSite starts from lastRow. If we deleted EnergyData, it starts from installed.
    // That might be too much. Let's just import last 30 days.

    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);

    // We can use the public importSite but it might try to import from 2023.
    // Let's manually call loadInterval in a loop or just hack importSite logic?
    // Actually, since we are in a script, we can just call loadInterval if we access it?
    // It's private.
    // So let's just use importSite but maybe update the "installed" date in DB temporarily?
    // Or just let it run. 30 days isn't that much? 
    // Wait, the site installed date is 2023. That's 2 years of data.
    // Let's just import the last 7 days for verification.

    // Hack removed. ensureDataForRange handles gaps.

    await importer.ensureDataForRange(siteId, start, end, (msg) => console.log(msg));

    // Verify results
    const rows = db.prepare(`
        SELECT id, name, from_day_of_week, to_day_of_week, from_hour, to_hour 
        FROM TariffSchedule 
        WHERE season_id IN (
            SELECT id FROM TariffSeason WHERE tariff_id IN (
                SELECT id FROM Tariff WHERE site_id = ?
            )
        )
    `).all(siteId);

    console.table(rows);
}

main().catch(console.error);
