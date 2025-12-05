import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { SettingsRepo } from '@/lib/settings-repo';
import { EnergyRepo } from '@/lib/energy-repo';
import { TeslaClient } from '@/lib/tesla-client';

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const granularity = searchParams.get('granularity') || 'day';

        const settingsRepo = new SettingsRepo();
        const token = settingsRepo.getAccessToken();
        const refreshToken = settingsRepo.getRefreshToken();

        if (!token) {
            return NextResponse.json({ error: 'No access token found' }, { status: 401 });
        }

        const repo = new EnergyRepo();
        const siteIds = repo.getSiteIds();

        const client = new TeslaClient({
            accessToken: token,
            refreshToken: refreshToken,
            onTokenUpdate: (newAccess, newRefresh) => {
                console.log('Refreshing tokens in DB');
                settingsRepo.setAccessToken(newAccess);
                settingsRepo.setRefreshToken(newRefresh);
            }
        });

        const importer = new Importer(client);

        for (const siteId of siteIds) {
            console.log(`Importing site ${siteId}`);
            await importer.importSite(siteId.toString(), granularity);
        }

        return NextResponse.json({ success: true, sitesImported: siteIds.length, granularity });
    } catch (error) {
        console.error('Import error full stack:', error);
        return NextResponse.json({ error: (error as Error).message, stack: (error as Error).stack }, { status: 500 });
    }
}
