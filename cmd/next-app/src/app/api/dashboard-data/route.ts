import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { Importer } from '@/lib/importer';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const cookieStore = await cookies();
        const token = cookieStore.get('access_token')?.value;

        if (!token) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const client = new TeslaClient(token);
        const products = await client.getProducts();

        // Fetch current tariff and live battery power for each site
        const repo = new EnergyRepo();
        const importer = new Importer(token);

        const productsWithTariff = await Promise.all(products.map(async (product) => {
            let site = repo.getSite(product.energy_site_id.toString());
            if (!site) {
                // Upsert the site/tariffs lazily when encountered from Tesla
                site = await importer.ensureSite(product.energy_site_id.toString());
            }
            let currentTariff = 'Unknown';
            let liveBatteryPower = product.battery_power;
            let liveSolarPower = 0;
            let liveLoadPower = 0;
            let liveGridPower = 0;

            // Get live status for real-time data
            try {
                const liveStatus = await client.getLiveStatus(product.energy_site_id.toString());
                liveBatteryPower = liveStatus.battery_power;
                liveSolarPower = liveStatus.solar_power;
                liveLoadPower = liveStatus.load_power;
                liveGridPower = liveStatus.grid_power;
            } catch (error) {
                console.warn(`Failed to fetch live status for site ${product.energy_site_id}:`, error);
            }

            if (site && site.tariffs.length > 0) {
                const schedule = new Schedule(site.tariffs);
                const tariffPeriod = schedule.getTariffPeriod(new Date());
                if (tariffPeriod) {
                    const season = tariffPeriod.season.name || 'Season';
                    const tariffName = tariffPeriod.tariff.name || 'Unknown';
                    currentTariff = `${season} - ${tariffName}`;
                }
            }

            return {
                id: product.id,
                site_name: product.site_name,
                energy_site_id: product.energy_site_id,
                percentage_charged: product.percentage_charged,
                currentTariff,
                liveBatteryPower,
                liveSolarPower,
                liveLoadPower,
                liveGridPower
            };
        }));

        return NextResponse.json({ products: productsWithTariff });
    } catch (error) {
        console.error('Dashboard data error:', error);
        return NextResponse.json({ error: 'Failed to fetch dashboard data' }, { status: 500 });
    }
}
