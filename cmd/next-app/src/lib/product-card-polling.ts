import { isValidSiteId, type SiteLiveCardData } from './site-live-data-client';

export interface PolledProduct {
    id: string;
    site_name: string;
    energy_site_id: string;
    type?: 'energy' | 'vehicle';
}

/**
 * One poll of the Products page: the card response for each energy site
 * (vehicles and products without a site id are skipped). Each card updates as
 * its answer arrives; a failure leaves that card as it was.
 */
export async function pollProductCards<P extends PolledProduct>(
    products: readonly P[],
    fetchCard: (siteId: string, signal?: AbortSignal) => Promise<SiteLiveCardData>,
    signal: AbortSignal,
    onData: (product: P, data: SiteLiveCardData) => void
): Promise<void> {
    await Promise.all(products.map(async product => {
        if (product.type === 'vehicle' || !isValidSiteId(product.energy_site_id)) return;
        try {
            const data = await fetchCard(product.energy_site_id, signal);
            if (!signal.aborted) onData(product, data);
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error(`Failed to load live data for ${product.site_name}`, error);
        }
    }));
}
