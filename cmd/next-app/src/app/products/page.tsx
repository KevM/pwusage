import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthorizedSiteIds } from '@/lib/auth-checks';
import { verifySiteToken } from '@/lib/auth-jwt';
import { SiteRepo } from '@/lib/site-repo';
import { DashboardCards, ProductWithLiveData } from '@/components/DashboardCards';
import { createTeslaClientForUser } from '@/lib/tesla-client-factory';
import { NoSupportedProducts } from '@/components/NoSupportedProducts';
import { NoPowerwallYet } from '@/components/no-powerwall-yet';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';

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

    const repo = new SiteRepo();
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
            const client = await createTeslaClientForUser(decoded.sub);
            if (client) {
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
        <PageShell maxWidth="6xl" className="mt-8">
            <div className="space-y-6">
                <PageHeader title="Tesla Products" density="compact" />
                {!hasEnergyProducts && (
                    <NoPowerwallYet />
                )}
                {products.length > 0 ? (
                    <DashboardCards initialProducts={products} />
                ) : (
                    <NoSupportedProducts />
                )}
            </div>
        </PageShell>
    );
}
