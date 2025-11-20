import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { SettingsRepo } from '@/lib/settings-repo';
import { TeslaClient } from '@/lib/tesla-client';

export async function POST() {
    try {
        const settingsRepo = new SettingsRepo();
        const token = settingsRepo.getAccessToken();

        if (!token) {
            return NextResponse.json({ error: 'No access token found' }, { status: 401 });
        }

        // Get all sites
        const client = new TeslaClient(token);
        const products = await client.getProducts();

        const importer = new Importer(token);

        for (const product of products) {
            console.log(`Importing site ${product.energy_site_id}`);
            await importer.importSite(product.energy_site_id.toString());
        }

        return NextResponse.json({ success: true, sitesImported: products.length });
    } catch (error) {
        console.error('Import error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
