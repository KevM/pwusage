import { cookies } from 'next/headers';
import Link from 'next/link';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { DashboardCards } from '@/components/DashboardCards';

// Force dynamic rendering to always fetch fresh data
export const dynamic = 'force-dynamic';

export default async function Home() {
  const cookieStore = await cookies();
  const token = cookieStore.get('access_token')?.value;

  if (!token) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-24">
        <h1 className="text-4xl font-bold mb-8">Powerwall Usage</h1>
        <Link
          href="/login"
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        >
          Login with Tesla
        </Link>
      </div>
    );
  }

  try {
    const client = new TeslaClient(token);
    const products = await client.getProducts();

    // Fetch current tariff and live battery power for each site
    const repo = new EnergyRepo();
    const productsWithTariff = await Promise.all(products.map(async (product) => {
      const site = repo.getSite(product.energy_site_id.toString());
      let currentTariff = 'Unknown';
      let liveBatteryPower = product.battery_power; // Fallback to products value
      let liveSolarPower = 0;
      let liveLoadPower = 0;
      let liveGridPower = 0;

      // Get live status for real-time battery power
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
        ...product,
        currentTariff,
        liveBatteryPower,
        liveSolarPower,
        liveLoadPower,
        liveGridPower
      };
    }));

    return (
      <div className="flex min-h-screen flex-col items-center p-24">
        <div className="w-full max-w-4xl">
          <DashboardCards initialProducts={productsWithTariff} />
        </div>
      </div>
    );
  } catch (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-24">
        <h1 className="text-4xl font-bold mb-8">Error</h1>
        <p className="text-red-500 mb-4">Failed to load products. Your session may have expired.</p>
        <p className="text-gray-500 mb-4">{(error as Error).message}</p>
        <Link
          href="/login"
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        >
          Re-Login
        </Link>
      </div>
    );
  }
}
