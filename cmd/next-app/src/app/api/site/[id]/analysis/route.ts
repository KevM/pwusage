
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { EnergyRepo, getUserTokensForSite } from '@/lib/energy-repo';
import { adaptTeslaData } from '@/lib/nilm/tesla-adapter';
import { detectLoads } from '@/lib/nilm/load-detection';
import { Schedule } from '@/lib/schedule';
import { TeslaClient } from '@/lib/tesla-client';
import { Importer } from '@/lib/importer';

const repo = new EnergyRepo();

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> } // Params is a Promise in Next 15+
) {
    try {
        const { id: siteId } = await params; // Await params
        const searchParams = request.nextUrl.searchParams;
        const dateParam = searchParams.get('date');
        const tzParam = searchParams.get('tz');

        let date = new Date();
        if (dateParam) {
            // Parse 'YYYY-MM-DD' strictly as local time parts
            const [y, m, d] = dateParam.split('-').map(Number);
            date = new Date(y, m - 1, d);
        } else if (tzParam) {
            // If no date provided, use "Today" in the requested timezone
            try {
                const parts = new Intl.DateTimeFormat('en-CA', {
                    timeZone: tzParam,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                }).format(new Date()).split('-').map(Number);
                date = new Date(parts[0], parts[1] - 1, parts[2]);
            } catch (e) {
                console.error('[Analysis] Invalid timezone:', tzParam, e);
                // Fallback to server time
            }
        }

        // AUTH CHECK
        const { cookies } = await import('next/headers');

        const { SiteService } = await import('@/lib/site-service');

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        if (!siteAuthToken) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Validate access to THIS specific site
        const siteService = new SiteService({ energyRepo: repo, siteAuthToken });
        if (!await siteService.validateSiteAccess(siteId)) {
            return NextResponse.json({ error: 'Unauthorized site access' }, { status: 403 });
        }

        // Set range to full day
        const start = new Date(date);
        start.setHours(0, 0, 0, 0);
        const end = new Date(date);
        end.setHours(23, 59, 59, 999);

        // For querying the DB, we want exclusive upper bound of Next Midnight to capture everything in the day
        const queryEnd = new Date(date);
        queryEnd.setDate(queryEnd.getDate() + 1);
        queryEnd.setHours(0, 0, 0, 0);

        if (isNaN(start.getTime())) {
            return NextResponse.json({ error: 'Invalid date' }, { status: 400 });
        }

        // 0. Auto-Heal / Sync Check
        const tokens = await getUserTokensForSite(siteId);
        if (tokens) {
            // Check if we need to sync. 
            // We can be optimistic and just check if we have ANY data for this day first?
            // Or just call ensureDataForRange which does the check efficiently.

            // Only sync if we are looking at specific date (not just "now" default?)
            // Or just always ensure. ensureDataForRange is smart.

            // We need to initialize TeslaClient with token refresh logic
            const handlers = repo.getLockedRefreshHandler(siteId);
            const teslaClient = new TeslaClient({
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                tokenRefreshHandler: handlers.refreshHandler,
                onTokenError: handlers.errorHandler
            });

            const importer = new Importer(teslaClient);
            // Don't force, let it detect gaps.
            await importer.ensureDataForRange(siteId, start, end);
        }

        // 1. Fetch Raw Data (Potential re-fetch if sync happened inside ensureDataForRange)
        // Check for tz param (now defined above)
        const rawData = await repo.getRawEnergyDataWithTz(siteId, start, queryEnd, tzParam || undefined);

        // 2. Fetch Tariff Definitions & Schedule
        const site = await repo.getSite(siteId);
        let schedule: Schedule | null = null;
        const tariffMap: Record<number, string> = {};

        if (site) {
            schedule = new Schedule(site.tariffs, site.timezone);

            site.tariffs.forEach(t => {
                if (t.name) {
                    tariffMap[t.id] = t.name;
                }
            });
        } else {
            console.warn(`[NILM API] Site ${siteId} not found`);
        }

        // ... (previous logic)

        // 3. Adapt to PowerData (Watts)
        const powerData = adaptTeslaData(rawData);

        // 4. Enrich with TOU Names
        if (schedule) {
            powerData.forEach(point => {
                const dateObj = new Date(point.timestamp);
                const tp = schedule!.getTariffPeriod(dateObj);
                if (tp && tp.schedule.name) {
                    point.touName = tp.schedule.name;
                } else if (point.tariffId != null) {
                    const name = tariffMap[point.tariffId];
                    if (name) point.touName = name;
                }
            });
        }

        // 5. Run Detection
        const detectedEvents = detectLoads(powerData, 1000);

        // 6. Fetch Persisted Tags
        const tagsRes = await repo.getLoadTags(siteId, start, end);

        // 7. Enrich Events with Tags (System & Manual)
        const enrichedEvents = detectedEvents.map(event => {
            const tags: string[] = [];

            // A. System Tag: Arbitrage Candidate
            // Criteria: Max Power > 2kW AND Peak Period
            // We check the TOU at the PEAK of the event (or average, but peak is safer)
            // Let's check the TOU of the datapoint at maxPower time
            const maxPowerPoint = powerData.find(p => new Date(p.timestamp).getTime() >= event.startTime.getTime() && p.powerWatts === event.maxPower);
            if (event.maxPower > 2000) {
                // Check if ANY point in the event is PEAK? Or just the max point?
                // Let's iterate the time range in powerData to be sure.
                if (maxPowerPoint?.touName?.toUpperCase().includes('PEAK') && !maxPowerPoint?.touName?.toUpperCase().includes('OFF')) {
                    tags.push('Arbitrage Candidate');
                }
            }

            // B. Manual Tags from DB
            // Match if tag.start_time matches event.startTime (fuzzy match mainly or exact?)
            // Since events are re-detected, exact start time might shift slightly if data changes?
            // Actually, we store "Start/End" in DB. Let's look for Overlaps or Approximate Matches.
            // Simplified: If tag time range overlaps event time range significantly.
            // OR User sends exact start/end from the event they clicked.
            // Let's match if DB tag start/end is roughly equal to event start/end.
            tagsRes.forEach(dbTag => {
                // 1 minute tolerance?
                const startDiff = Math.abs(dbTag.start_time.getTime() - event.startTime.getTime());
                const endDiff = Math.abs(dbTag.end_time.getTime() - event.endTime.getTime());
                if (startDiff < 60000 && endDiff < 60000) {
                    tags.push(dbTag.tag);
                }
            });

            return { ...event, tags };
        });

        return NextResponse.json({
            siteId,
            date: date.toISOString(),
            data: powerData,
            events: enrichedEvents,
            tariffs: tariffMap
        });

    } catch (error) {
        console.error('Error fetching NILM data:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: siteId } = await params;
        const body = await request.json();
        const { action, start_time, end_time, tag } = body;


        const { cookies } = await import('next/headers');

        const { SiteService } = await import('@/lib/site-service');

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        if (!siteAuthToken) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const siteService = new SiteService({ energyRepo: repo, siteAuthToken });
        if (!await siteService.validateSiteAccess(siteId)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        if (!action || !start_time || !end_time || !tag) {
            return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
        }

        const start = new Date(start_time);
        const end = new Date(end_time);

        if (action === 'add_tag') {
            await repo.addLoadTag(siteId, start, end, tag);
            return NextResponse.json({ success: true });
        } else if (action === 'remove_tag') {
            await repo.removeLoadTag(siteId, start, end, tag);
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

    } catch (e) {
        console.error('Error in NILM POST:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}
