import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');

        if (!siteId) {
            return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
        }

        const cookieStore = await cookies();
        const token = cookieStore.get('access_token')?.value;

        if (!token) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const client = new TeslaClient(token);
        const repo = new EnergyRepo();

        // Get live status
        const liveStatus = await client.getLiveStatus(siteId);

        // Get current tariff
        const site = repo.getSite(siteId);
        let currentTariff = 'Unknown';

        if (site && site.tariffs.length > 0) {
            const schedule = new Schedule(site.tariffs);
            const tariffPeriod = schedule.getTariffPeriod(new Date());
            if (tariffPeriod) {
                const season = tariffPeriod.season.name || 'Season';
                const tariffName = tariffPeriod.tariff.name || 'Unknown';
                currentTariff = `${season} - ${tariffName}`;
            }
        }

        return NextResponse.json({
            solarPower: liveStatus.solar_power,
            loadPower: liveStatus.load_power,
            batteryPower: liveStatus.battery_power,
            gridPower: liveStatus.grid_power,
            percentageCharged: liveStatus.percentage_charged,
            currentTariff
        });
    } catch (error) {
        console.error('Site live data error:', error);
        return NextResponse.json({ error: 'Failed to fetch site live data' }, { status: 500 });
    }
}
