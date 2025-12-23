import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifySiteToken } from '@/lib/auth-jwt';
import { EnergyRepo } from '@/lib/energy-repo';
import { DashboardCards, ProductWithLiveData } from '@/components/DashboardCards';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
    const cookieStore = await cookies();
    const siteAuthToken = cookieStore.get('site_auth')?.value;

    if (!siteAuthToken) {
        redirect('/login');
    }

    const repo = new EnergyRepo();
    let energyProducts: ProductWithLiveData[] = [];
    const vehicleProducts: ProductWithLiveData[] = []; // Store vehicles

    if (siteAuthToken) {
        const siteIds = verifySiteToken(siteAuthToken);
        if (siteIds && siteIds.length > 0) {
            const sitePromises = siteIds.map(id => repo.getSite(id));
            const sitesResults = await Promise.all(sitePromises);
            const validSites = sitesResults.filter((s): s is NonNullable<typeof s> => !!s);
            energyProducts = validSites.map(s => ({
                id: s.id,
                site_name: s.name,
                energy_site_id: s.id,
                percentage_charged: 0,
                currentTariff: 'Loading...',
                liveBatteryPower: 0,
                liveSolarPower: 0,
                liveLoadPower: 0,
                liveGridPower: 0,
                type: 'energy' // Marker
            }));
        }
    }

    const products = [...energyProducts, ...vehicleProducts];

    return (
        <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="w-full max-w-6xl mt-8">
                <h1 className="text-3xl font-bold mb-6">Tesla Products</h1>
                <DashboardCards initialProducts={products} />
            </div>
        </div>
    );
}
