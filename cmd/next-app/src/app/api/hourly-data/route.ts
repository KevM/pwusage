import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteService } from '@/lib/site-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');
        const dateStr = searchParams.get('date');
        const tz = searchParams.get('tz') || undefined;

        if (!siteId || !dateStr) {
            return NextResponse.json({ error: 'Missing siteId or date' }, { status: 400 });
        }

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        const repo = new EnergyRepo();
        const service = new SiteService({ energyRepo: repo, siteAuthToken });

        if (!await service.validateSiteAccess(siteId)) {
            return NextResponse.json({ error: 'Unauthorized access to site' }, { status: 403 });
        }

        const site = await repo.getSite(siteId);
        if (!site) {
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }

        const hourlyData = await repo.getHourlyEnergyData(siteId, dateStr, tz);

        return NextResponse.json(
            {
                date: dateStr,
                data: hourlyData,
                timezone: tz || site.timezone // Return the effective timezone
            },
            {
                headers: {
                    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            }
        );
    } catch (error) {
        console.error('Hourly data error:', error);
        return NextResponse.json({ error: 'Failed to fetch hourly data' }, { status: 500 });
    }
}
