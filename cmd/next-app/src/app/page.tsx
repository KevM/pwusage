import { cookies } from 'next/headers';
import Link from 'next/link';
import { TeslaClient, FleetProduct } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { DashboardCards } from '@/components/DashboardCards';
import { NoSupportedProducts } from '@/components/NoSupportedProducts';
import { verifySiteToken } from '@/lib/auth-jwt';

// Force dynamic rendering to always fetch fresh data
export const dynamic = 'force-dynamic';

export default async function Home() {
  const cookieStore = await cookies();
  let token = cookieStore.get('access_token')?.value;
  let refreshToken = cookieStore.get('refresh_token')?.value;
  let activeSiteId: string | null = null;

  // Try to upgrade to fresh DB tokens if we have site access
  // This prevents issues where the browser cookies are stale because Trmnl/Background service rotated the tokens
  const siteAuthToken = cookieStore.get('site_auth')?.value;
  if (siteAuthToken) {
    const siteIds = verifySiteToken(siteAuthToken);
    if (siteIds && siteIds.length > 0) {
      const repo = new EnergyRepo();
      // Use the first authorized site as the token source of truth
      const primarySite = await repo.getSite(siteIds[0]);
      if (primarySite && primarySite.access_token && primarySite.refresh_token) {
        console.log(`[Dashboard] Using DB tokens from Site ${primarySite.id}`);
        token = primarySite.access_token;
        refreshToken = primarySite.refresh_token;
        activeSiteId = primarySite.id;
      }
    }
  }

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

  interface ProductWithTariff extends FleetProduct {
    currentTariff: string;
    liveBatteryPower: number;
    liveSolarPower: number;
    liveLoadPower: number;
    liveGridPower: number;
  }

  let productsWithTariff: ProductWithTariff[] = [];
  let hasProducts = false;
  let fetchError = null;

  try {
    // Determine refresh handler if we identified a site
    let refreshHandler;
    if (activeSiteId) {
      const repo = new EnergyRepo();
      refreshHandler = repo.getLockedRefreshHandler(activeSiteId);
    }

    const client = new TeslaClient({
      accessToken: token!,
      refreshToken: refreshToken,
      tokenRefreshHandler: refreshHandler,
      onTokenUpdate: () => {
        console.log('Tokens refreshed during Dashboard render');
      }
    });

    const products = (await client.getProducts()).filter(p => p.components.battery);

    if (products.length > 0) {
      hasProducts = true;

      // Fetch current tariff and live battery power for each site
      const repo = new EnergyRepo();
      productsWithTariff = await Promise.all(products.map(async (product) => {
        const site = await repo.getSite(product.energy_site_id.toString());
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
          const schedule = new Schedule(site.tariffs, site.timezone);
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
    }
  } catch (error) {
    fetchError = error;
  }

  if (fetchError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4 md:p-8 lg:p-24">
        <h1 className="text-4xl font-bold mb-8">Error</h1>
        <p className="text-red-500 mb-4">Failed to load products. Your session may have expired.</p>
        <p className="text-gray-500 mb-4">{(fetchError as Error).message}</p>
        <Link
          href="/login"
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        >
          Re-Login
        </Link>
      </div>
    );
  }

  if (!hasProducts) {
    return (
      <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
        <div className="w-full max-w-xl mt-12">
          <NoSupportedProducts />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
      <div className="w-full max-w-6xl">
        <DashboardCards initialProducts={productsWithTariff} />
      </div>
    </div>
  );
}
