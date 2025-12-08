import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { Importer } from '@/lib/importer';
import { setSiteClaims } from '@/lib/auth-checks';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const cookieStore = await cookies();
        const token = cookieStore.get('access_token')?.value;
        const refreshToken = cookieStore.get('refresh_token')?.value;

        if (!token) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const client = new TeslaClient({
            accessToken: token,
            refreshToken: refreshToken,
            onTokenUpdate: (newAccess, newRefresh) => {
                console.log('Refreshing tokens in Cookies from Dashboard API');
                // Note: We can't set cookies easily in a callback here without passing the response object
                // For now, we'll rely on the fact that if this fails, the user will just have to login again eventually
                // OR we can try to find a way to set them on the response we are about to return
                // A better approach might be to let the client return the new tokens and we set them here
            }
        });

        const products = (await client.getProducts()).filter(p => p.components.battery);

        // Update security claims for these sites
        const siteIds = products.map(p => p.energy_site_id.toString());
        await setSiteClaims(siteIds);

        // Fetch current tariff and live battery power for each site
        const repo = new EnergyRepo();
        const importer = new Importer(client);

        const productsWithTariff = await Promise.all(products.map(async (product) => {
            let site = await repo.getSite(product.energy_site_id.toString());
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
                const schedule = new Schedule(site.tariffs, site.timezone);
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
