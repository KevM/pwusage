import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { EnergyRepo } from '@/lib/energy-repo';
import { TeslaClient } from '@/lib/tesla-client';

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const granularity = searchParams.get('granularity') || 'day';

        const cookieStore = await cookies();
        const token = cookieStore.get('access_token')?.value;
        const refreshToken = cookieStore.get('refresh_token')?.value;

        if (!token) {
            return NextResponse.json({ error: 'No access token found' }, { status: 401 });
        }

        const repo = new EnergyRepo();
        const siteIds = repo.getSiteIds();

        const client = new TeslaClient({
            accessToken: token,
            refreshToken: refreshToken,
            onTokenUpdate: (newAccess, newRefresh) => {
                console.log('Refreshing tokens in Cookies from Import API');
                cookieStore.set('access_token', newAccess, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
                cookieStore.set('refresh_token', newRefresh, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
            }
        });

        const importer = new Importer(client);

        // Default behavior (Auto-import recent history)
        // Replaces old worker behavior with a robust gap-filling import for the last 14 days
        const now = new Date();
        const autoBackfillLimit = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        for (const siteId of siteIds) {
            console.log(`Auto-importing site ${siteId} (last 14 days)`);
            // ensureDataForRange checks for gaps and fills them, avoiding duplicate work
            await importer.ensureDataForRange(siteId.toString(), autoBackfillLimit, now);
        }

        return NextResponse.json({ success: true, sitesImported: siteIds.length, granularity });
    } catch (error) {
        console.error('Import error full stack:', error);
        return NextResponse.json({ error: (error as Error).message, stack: (error as Error).stack }, { status: 500 });
    }
}
