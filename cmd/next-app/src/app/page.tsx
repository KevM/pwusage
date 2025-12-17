import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { verifySiteToken } from '@/lib/auth-jwt';
import { EnergyRepo } from '@/lib/energy-repo';
import { ProductWithLiveData } from '@/components/DashboardCards';

// Force dynamic rendering to always fetch fresh data
export const dynamic = 'force-dynamic';

export default async function Home() {
  const cookieStore = await cookies();
  const token = cookieStore.get('access_token')?.value;
  const siteAuthToken = cookieStore.get('site_auth')?.value;

  // If no token at all, show login screen
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

  // If we have site auth, but we want to show the Dashboard (Products Page) instead of redirecting
  // we should check if we have sites to show.

  let products: ProductWithLiveData[] = []; // We will map this to ProductWithLiveData
  const repo = new EnergyRepo();

  if (siteAuthToken) {
    const siteIds = verifySiteToken(siteAuthToken);
    if (siteIds && siteIds.length > 0) {
      // We have sites! Fetch them.
      // We don't have "live data" here yet efficiently without making N API calls or reusing the internal API logic.
      // For now, let's just fetch the Sites from repo using the authorized IDs.
      const sitePromises = siteIds.map(id => repo.getSite(id));
      const sitesResults = await Promise.all(sitePromises);
      const validSites = sitesResults.filter((s): s is NonNullable<typeof s> => !!s);

      // Map to structure expected by DashboardCards (even if live data is initially empty/zero)
      products = validSites.map(s => ({
        id: s.id,
        site_name: s.name,
        energy_site_id: s.id, // Keeping compatibility
        percentage_charged: 0,
        currentTariff: 'Loading...',
        liveBatteryPower: 0,
        liveSolarPower: 0,
        liveLoadPower: 0,
        liveGridPower: 0
      }));
    }
  } else if (token) {
    // Legacy token fallback
    const sites = await repo.getSites();
    products = sites.map(s => ({
      id: s.id,
      site_name: s.name,
      energy_site_id: s.id,
      percentage_charged: 0,
      currentTariff: 'Loading...',
      liveBatteryPower: 0,
      liveSolarPower: 0,
      liveLoadPower: 0,
      liveGridPower: 0
    }));
  }

  // Logic: 
  // 1. If > 1 Energy Site -> Products
  // 2. If 1 Energy Site -> Redirect to Site (UNLESS we have vehicles?)
  //    User said: "if there is only one energy site they will automatically be redirected to that site's page. Otherwise redirect them to the product page so they can pick one."
  //    "Please add support to the product page for Tesla car products."
  //    If I have 1 Powerwall and 1 Car, I probably want to see the product page to pick the Car?
  //    But the user strictly said "If they have only one energy site they will automatically be redirected to that site's page."
  //    So even if I have a car, I go to the Energy Site page? And then maybe I can click "Products" to go back?
  //    "Otherwise redirect them to the product page so they can pick one." -> This implies if I have multiple *options* to pick.
  //    Let's stick to the strict rule: "If they have only one energy site -> redirect to it".
  //    This implies Vehicles are secondary. The user can navigate back to Products from the site page if they want to see the car.

  if (products.length === 1) {
    redirect(`/site/${products[0].id}`);
  } else if (products.length > 1) {
    redirect('/products');
  } else {
    // 0 energy sites.
    // Redirect to products page (it will try to show vehicles or "No Products")
    redirect('/products');
  }

  // This code below is unreachable now due to redirects, but kept for type safety if logic changes
  return null;
}
