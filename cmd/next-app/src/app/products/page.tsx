import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthorizedSiteIds } from '@/lib/auth-checks';
import { verifySiteToken } from '@/lib/auth-jwt';
import { EnergyRepo, getUserTokens } from '@/lib/energy-repo';
import { DashboardCards, ProductWithLiveData } from '@/components/DashboardCards';
import { TeslaClient } from '@/lib/tesla-client';
import { NoSupportedProducts } from '@/components/NoSupportedProducts';
import { NoPowerwallYet } from '@/components/no-powerwall-yet';

export const dynamic = 'force-dynamic';

interface VehicleMeta {
    state?: string;
    vehicle_id?: number;
    option_codes?: string;
}

type ProductsSearchParams = Promise<{ debugNoEnergy?: string | string[] }>;

export default async function ProductsPage({ searchParams }: { searchParams: ProductsSearchParams }) {
    const cookieStore = await cookies();
    const siteAuthToken = cookieStore.get('site_auth')?.value;
    const query = await searchParams;
    const debugNoEnergyRaw = query.debugNoEnergy;
    const debugNoEnergy = Array.isArray(debugNoEnergyRaw) ? debugNoEnergyRaw.includes('1') : debugNoEnergyRaw === '1';
    const shouldHideEnergyForDebug = process.env.NODE_ENV !== 'production' && debugNoEnergy;

    if (!siteAuthToken) {
        redirect('/login');
    }

    const decoded = verifySiteToken(siteAuthToken);
    if (!decoded) {
        redirect('/login');
    }

    const repo = new EnergyRepo();
    let energyProducts: ProductWithLiveData[] = [];
    let vehicleProducts: ProductWithLiveData[] = [];

    const targetSiteIds = await getAuthorizedSiteIds();

    if (targetSiteIds.length > 0 && !shouldHideEnergyForDebug) {
        const sitePromises = targetSiteIds.map(id => repo.getSite(id));
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

    if (decoded.sub) {
        try {
            const userTokens = await getUserTokens(decoded.sub);
            if (userTokens?.access_token) {
                const client = new TeslaClient({
                    accessToken: userTokens.access_token,
                    refreshToken: userTokens.refresh_token || undefined
                });
                const fleetProducts = await client.getProducts();
                vehicleProducts = fleetProducts
                    .filter((product) => product.resource_type === 'vehicle' || !!product.vehicle_id || !!product.vin)
                    .map((product) => {
                        const displayName = product.display_name || product.site_name || 'Tesla Vehicle';
                        const vehicleIdentifier = product.vehicle_id?.toString() || product.id_s || product.id;
                        const meta: VehicleMeta = {
                            state: product.state,
                            vehicle_id: product.vehicle_id,
                            option_codes: product.option_codes
                        };

                        return {
                            id: `vehicle-${vehicleIdentifier}`,
                            site_name: displayName,
                            energy_site_id: `vehicle-${vehicleIdentifier}`,
                            percentage_charged: 0,
                            currentTariff: product.vin || '--',
                            liveBatteryPower: 0,
                            liveSolarPower: 0,
                            liveLoadPower: 0,
                            liveGridPower: 0,
                            type: 'vehicle',
                            meta
                        };
                    });
            }
        } catch (error) {
            console.warn('[ProductsPage] Failed to load vehicle products:', error);
        }
    }

    const products = [...energyProducts, ...vehicleProducts];
    const hasEnergyProducts = energyProducts.length > 0;

    return (
        <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="w-full max-w-6xl mt-8">
                <h1 className="text-3xl font-bold mb-6">Tesla Products</h1>
                {!hasEnergyProducts && (
                    <div className="mb-6">
                        <NoPowerwallYet />
                    </div>
                )}
                {products.length > 0 ? (
                    <DashboardCards initialProducts={products} />
                ) : (
                    <NoSupportedProducts />
                )}
            </div>
        </div>
    );
}
