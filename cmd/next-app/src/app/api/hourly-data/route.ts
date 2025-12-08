import { NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { verifySiteAccess } from '@/lib/auth-checks';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');
        const dateStr = searchParams.get('date');

        if (!siteId || !dateStr) {
            return NextResponse.json({ error: 'Missing siteId or date' }, { status: 400 });
        }

        if (!await verifySiteAccess(siteId)) {
            return NextResponse.json({ error: 'Unauthorized access to site' }, { status: 403 });
        }

        const repo = new EnergyRepo();
        const site = repo.getSite(siteId);
        if (!site) {
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }

        const hourlyData = repo.getHourlyEnergyData(siteId, dateStr, site.timezone);

        return NextResponse.json(
            {
                date: dateStr,
                data: hourlyData,
                timezone: site.timezone
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
