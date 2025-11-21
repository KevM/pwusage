import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { SettingsRepo } from '@/lib/settings-repo';
import { EnergyRepo } from '@/lib/energy-repo';

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const granularity = searchParams.get('granularity') || 'day';

        const settingsRepo = new SettingsRepo();
        const token = settingsRepo.getAccessToken();

        if (!token) {
            return NextResponse.json({ error: 'No access token found' }, { status: 401 });
        }

        const repo = new EnergyRepo();
        const siteIds = repo.getSiteIds();
        const importer = new Importer(token);

        for (const siteId of siteIds) {
            console.log(`Importing site ${siteId}`);
            await importer.importSite(siteId.toString(), granularity);
        }

        return NextResponse.json({ success: true, sitesImported: siteIds.length, granularity });
    } catch (error) {
        console.error('Import error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
