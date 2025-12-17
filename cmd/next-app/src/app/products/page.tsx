import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifySiteToken } from '@/lib/auth-jwt';
import { EnergyRepo } from '@/lib/energy-repo';
import { DashboardCards, ProductWithLiveData } from '@/components/DashboardCards';
import { TeslaClient, FleetProduct } from '@/lib/tesla-client';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
    const cookieStore = await cookies();
    const token = cookieStore.get('access_token')?.value;
    const siteAuthToken = cookieStore.get('site_auth')?.value;

    if (!token && !siteAuthToken) {
        redirect('/login');
    }

    const repo = new EnergyRepo();
    let energyProducts: ProductWithLiveData[] = [];
    let vehicleProducts: ProductWithLiveData[] = []; // Store vehicles

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
    } else if (token) {
        // Legacy: Fetch from Repo
        const sites = await repo.getSites();
        energyProducts = sites.map(s => ({
            id: s.id,
            site_name: s.name,
            energy_site_id: s.id,
            percentage_charged: 0,
            currentTariff: 'Loading...',
            liveBatteryPower: 0,
            liveSolarPower: 0,
            liveLoadPower: 0,
            liveGridPower: 0,
            type: 'energy'
        }));
    }

    // Fetch Vehicles if we have a main access token
    if (token) {
        try {
            const client = new TeslaClient(token);
            // Now getProducts returns everything
            const allRaw: FleetProduct[] = await client.getProducts();

            // Filter for vehicles (no energy_site_id or resource_type starts with 'battery'/'solar' check?)
            // Usually vehicles have 'vin' or 'vehicle_id'. FleetProduct interface might need update.
            // Just filtering by absence of energy_site_id for now as "Vehicles"
            // Or better: filter by resource_type not being 'battery' or 'solar' if available?
            // Actually, usually vehicles have 'vin'. Let's check keys.
            // For now, let's just grab items that DO NOT match our Energy Site IDs to avoid dupes?
            // Or simple:

            const vehicles = allRaw.filter(p => !p.energy_site_id);

            if (vehicles.length > 0) {
                console.log('[ProductsPage] Raw Vehicle Data Sample:', JSON.stringify(vehicles[0], null, 2));
            }

            vehicleProducts = vehicles.map(v => ({
                id: v.id_s || v.id || 'unknown',
                site_name: v.display_name || 'Tesla Vehicle',
                energy_site_id: (v.vehicle_id || 0).toString(), // Use vehicle_id as placeholder
                percentage_charged: 0, // Would need vehicle_data to get real %
                currentTariff: v.vin || 'Unknown VIN', // Store VIN here for display
                liveBatteryPower: 0,
                liveSolarPower: 0,
                liveLoadPower: 0,
                liveGridPower: 0,
                type: 'vehicle',
                meta: v // Pass full object
            }));

        } catch (e) {
            console.error("Failed to fetch vehicles", e);
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
