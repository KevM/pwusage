import { NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');
        const dateStr = searchParams.get('date');

        if (!siteId || !dateStr) {
            return NextResponse.json({ error: 'Missing siteId or date' }, { status: 400 });
        }

        const repo = new EnergyRepo();
        const date = new Date(dateStr + 'T00:00:00');
        const hourlyData = repo.getHourlyEnergyData(siteId, date);

        return NextResponse.json(
            {
                date: dateStr,
                data: hourlyData
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
