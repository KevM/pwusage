
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { TeslaTokenRepo } from '@/lib/tesla-token-repo';
import { LoadTagRepo } from '@/lib/load-tag-repo';
import { UserRepo } from '@/lib/user-repo';
import { adaptTeslaData } from '@/lib/nilm/tesla-adapter';
import { detectLoads } from '@/lib/nilm/load-detection';
import { Schedule } from '@/lib/schedule';
import { TeslaClient } from '@/lib/tesla-client';
import { Importer } from '@/lib/importer';
import { withRequestContext } from '@/lib/request-context';
import { getSiteTodayMidnight, safeParseSiteLocalDateToMidnight, addDaysInSiteTimezone } from '@/lib/date-utils';

const repo = new EnergyRepo();
const siteRepo = new SiteRepo();
const tokenRepo = new TeslaTokenRepo(siteRepo);
const tagRepo = new LoadTagRepo();

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> } // Params is a Promise in Next 15+
) {
    return withRequestContext(async () => {
        try {
        const { id: siteId } = await params;
        const searchParams = request.nextUrl.searchParams;
        const dateParam = searchParams.get('date');
        const tzParam = searchParams.get('tz');

        const site = await siteRepo.getSite(siteId);
        if (!site) {
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }

        const tz = tzParam || site.timezone;
        let start: Date;

        if (dateParam) {
            start = safeParseSiteLocalDateToMidnight(dateParam, tz) || new Date(NaN);
        } else {
            start = getSiteTodayMidnight(tz);
        }

        const queryEnd = isNaN(start.getTime())
            ? new Date(NaN)
            : addDaysInSiteTimezone(start, 1, tz);
        const end = isNaN(queryEnd.getTime())
            ? new Date(NaN)
            : new Date(queryEnd.getTime() - 1); // 23:59:59.999

        // AUTH CHECK
        const { cookies } = await import('next/headers');
        const { SiteService } = await import('@/lib/site-service');

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;
        if (siteAuthToken) {
            // Validate access to THIS specific site
            const siteService = new SiteService({ siteRepo, siteAuthToken });
            if (!await siteService.validateSiteAccess(siteId)) {
                return NextResponse.json({ error: 'Unauthorized site access' }, { status: 403 });
            }
        } else {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (isNaN(start.getTime())) {
            return NextResponse.json({ error: 'Invalid date' }, { status: 400 });
        }

        // 0. Auto-Heal / Sync Check
        const tokens = await new UserRepo().getTokensForSite(siteId);
        let importer: Importer | null = null;

        if (tokens) {
            // We need to initialize TeslaClient with token refresh logic
            const handlers = tokenRepo.getLockedRefreshHandler(siteId);
            const teslaClient = new TeslaClient({
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                tokenRefreshHandler: handlers.refreshHandler,
                onTokenError: handlers.errorHandler
            });

            const force = searchParams.get('force') === 'true';
            importer = new Importer(teslaClient);
            console.error(`[Analysis] Calling ensureDataForRange for ${siteId}, force=${force}`);
            try {
                await importer.ensureDataForRange(siteId, start, queryEnd, (msg) => {
                    console.error(`[Analysis Progress] ${msg}`);
                }, { force });
            } catch (err) {
                console.error(`[Analysis] Auto-sync failed (gracefully continuing with DB data):`, err);
            }
        } else {
            // Fallback for audit if no tokens (though TeslaClient might throw later)
            importer = new Importer(null as unknown as TeslaClient);
        }

        // 1. Fetch Raw Data (Potential re-fetch if sync happened inside ensureDataForRange)
        const rawData = await repo.getRawEnergyData(siteId, start, queryEnd);

        // 2. Fetch Tariff Definitions & Schedule
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
        const tagsRes = await tagRepo.getLoadTags(siteId, start, end);

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

        const audit = await importer.auditRange(siteId, start, queryEnd);

        return NextResponse.json({
            siteId,
            date: start.toISOString(),
            data: powerData,
            events: enrichedEvents,
            tariffs: tariffMap,
            audit
        });

        } catch (error) {
            console.error('Error fetching NILM data:', error);
            return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
        }
    });
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return withRequestContext(async () => {
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

        const siteService = new SiteService({ siteRepo, siteAuthToken });
        if (!await siteService.validateSiteAccess(siteId)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        if (!action || !start_time || !end_time || !tag) {
            return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
        }

        const start = new Date(start_time);
        const end = new Date(end_time);

        if (action === 'add_tag') {
            await tagRepo.addLoadTag(siteId, start, end, tag);
            return NextResponse.json({ success: true });
        } else if (action === 'remove_tag') {
            await tagRepo.removeLoadTag(siteId, start, end, tag);
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

        } catch (e) {
            console.error('Error in NILM POST:', e);
            return NextResponse.json({ error: 'Server Error' }, { status: 500 });
        }
    });
}
