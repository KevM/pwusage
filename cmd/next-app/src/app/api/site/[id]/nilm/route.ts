
import { NextRequest, NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { adaptTeslaData } from '@/lib/nilm/tesla-adapter';
import { detectLoads } from '@/lib/nilm/load-detection';

const repo = new EnergyRepo();

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> } // Params is a Promise in Next 15+
) {
    try {
        const { id: siteId } = await params; // Await params
        const searchParams = request.nextUrl.searchParams;
        const dateParam = searchParams.get('date');

        const date = dateParam ? new Date(dateParam) : new Date();

        // Set range to full day (Local or UTC? Usually API expects ISO or simple YYYY-MM-DD)
        // Let's assume input 'date' is effectively "Start of Day".
        // Or simpler: User passes specific start/end.
        // Let's default to "Requested Date 00:00" to "Requested Date 23:59:59".

        const start = new Date(date);
        start.setHours(0, 0, 0, 0);
        const end = new Date(date);
        end.setHours(23, 59, 59, 999);

        if (isNaN(start.getTime())) {
            return NextResponse.json({ error: 'Invalid date' }, { status: 400 });
        }

        // 1. Fetch Raw Data
        const rawData = await repo.getRawEnergyData(siteId, start, end);

        // 2. Adapt to PowerData (Watts)
        const powerData = adaptTeslaData(rawData);

        // 3. Run Detection on the fly
        const events = detectLoads(powerData, 1000); // 1000W Threshold

        return NextResponse.json({
            siteId,
            date: date.toISOString(),
            data: powerData, // { timestamp, powerWatts, tariffId }
            events: events
        });

    } catch (error) {
        console.error('Error fetching NILM data:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
