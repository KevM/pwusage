
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { EnergyRepo } from '@/lib/energy-repo';
import { adaptTeslaData } from '@/lib/nilm/tesla-adapter';
import { detectLoads } from '@/lib/nilm/load-detection';
import { Schedule } from '@/lib/schedule';

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
        const start = new Date(date);
        start.setHours(0, 0, 0, 0);
        const end = new Date(date);
        end.setHours(23, 59, 59, 999);

        if (isNaN(start.getTime())) {
            return NextResponse.json({ error: 'Invalid date' }, { status: 400 });
        }

        // 1. Fetch Raw Data
        const rawData = await repo.getRawEnergyData(siteId, start, end);

        // 2. Fetch Tariff Definitions & Schedule
        const site = await repo.getSite(siteId);
        let schedule: Schedule | null = null;
        const tariffMap: Record<number, string> = {};

        if (site) {
            console.log(`[NILM API] Init Schedule for Site ${siteId} with ${site.tariffs.length} tariffs`);
            schedule = new Schedule(site.tariffs, site.timezone);

            site.tariffs.forEach(t => {
                tariffMap[t.id] = t.name;
            });
        } else {
            console.warn(`[NILM API] Site ${siteId} not found`);
        }

        // 3. Adapt to PowerData (Watts)
        const powerData = adaptTeslaData(rawData);

        // 4. Enrich with TOU Names
        if (schedule) {
            let matches = 0;
            powerData.forEach(point => {
                const dateObj = new Date(point.timestamp); // Ensure Date object
                const tp = schedule!.getTariffPeriod(dateObj);
                if (tp) {
                    point.touName = tp.schedule.name; // e.g., "Peak", "Off-Peak"
                    matches++;
                } else if (point.tariffId) {
                    point.touName = tariffMap[point.tariffId];
                }
            });
            console.log(`[NILM API] Enriched ${powerData.length} points. Matched TOU: ${matches}`);
        }

        // 5. Run Detection on the fly
        const events = detectLoads(powerData, 1000); // 1000W Threshold

        return NextResponse.json({
            siteId,
            date: date.toISOString(),
            data: powerData, // { timestamp, powerWatts, tariffId, touName }
            events: events,
            tariffs: tariffMap
        });

    } catch (error) {
        console.error('Error fetching NILM data:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
