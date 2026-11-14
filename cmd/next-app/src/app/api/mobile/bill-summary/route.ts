import {readBillingAvailability} from '@/lib/billing-availability';
import { NextResponse } from 'next/server';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { SiteRepo } from '@/lib/site-repo';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import { getCurrentCycleStart, getNextCycleStart } from '@/lib/billing-cycle';
import { MOBILE_DASHBOARD_CONTRACT_VERSION } from '@/lib/mobile-dashboard-contract';
import { buildMobileLoadTiming, summarizeBillUsage } from '@/lib/mobile-bill-summary';
import { Schedule } from '@/lib/schedule';
import { buildLoadTimingTimeline } from '@/lib/load-timing-timeline';
import { matchesMobileBillConfiguration, readCurrentMobileSite, readMobileBillConfiguration, readMobileBillRevision } from '@/lib/mobile-bill-revision';
import { getSiteReattributionStatus } from '@/lib/tariff-reattribution';

export const dynamic = 'force-dynamic';

const PRIVATE_RESPONSE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
    return withRequestContext(async () => {
        try {
            const params = new URL(request.url).searchParams;
            const siteId = params.get('siteId');
            const includeOutlook = params.get('outlook') === '1';
            const knownRevision = includeOutlook ? params.get('knownRevision') : null;
            if (!siteId) return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
            if (!(await verifySiteAccess(siteId))) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }

            const siteRepo = new SiteRepo();
            const { site, config: currentConfig } = knownRevision !== null
                ? await readCurrentMobileSite(siteRepo, siteId)
                : { site: await siteRepo.getSite(siteId), config: null };
            if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

            const now = new Date();
            const billingDay = site.billing_start_day || 1;
            const cycleStart = getCurrentCycleStart(billingDay, now, site.timezone);
            const cycleEnd = getNextCycleStart(billingDay, cycleStart, site.timezone);
            const schedule = new Schedule(site.tariffs, site.timezone);
            const beforeReattribution = currentConfig ? await getSiteReattributionStatus(siteId) : undefined;
            const before = currentConfig
                ? await readMobileBillRevision(site, currentConfig, schedule, cycleStart, cycleEnd, now, includeOutlook, beforeReattribution)
                : null;
            if (before && before === knownRevision) {
                return new NextResponse(null, { status: 304, headers: PRIVATE_RESPONSE });
            }
            const energyRepo = createEnergyRepo(site.timezone);
            const [billing, currencyCode, energyDataThrough, fetchedReattribution] = await Promise.all([
                readBillingAvailability(async () => includeOutlook
                    ? energyRepo.getBillOutlook(siteId, cycleStart, cycleEnd)
                    : { usage: await energyRepo.getUsageByTOU(siteId, cycleStart, cycleEnd), outlook: null },
                    { usage: [], outlook: null }),
                currentConfig ? Promise.resolve(currentConfig.currency) : siteRepo.getSiteCurrencyCode(siteId),
                energyRepo.getLatestTimestamp(siteId),
                beforeReattribution === undefined ? getSiteReattributionStatus(siteId) : Promise.resolve(beforeReattribution),
            ]);
            let tariffReattribution = fetchedReattribution;
            let revision: string | undefined;
            if (before && billing.status === 'complete') {
                try {
                    const [afterConfig, afterReattribution] = await Promise.all([
                        readMobileBillConfiguration(siteId),
                        getSiteReattributionStatus(siteId),
                    ]);
                    tariffReattribution = afterReattribution;
                    const after = afterConfig && matchesMobileBillConfiguration(site, afterConfig)
                        ? await readMobileBillRevision(site, afterConfig, schedule, cycleStart, cycleEnd, now, includeOutlook, afterReattribution)
                        : null;
                    // A writer may commit between the validator read and billing.
                    // In that case the response must not authorize later reuse.
                    if (before === after) revision = before;
                } catch (error) {
                    // The bill is still usable; only its later reuse is lost.
                    console.warn('[mobile-bill-summary] revision check failed:', error);
                }
            }
            const usage = billing.value.usage;
            const { estimatedCost, periods } = summarizeBillUsage(usage);
            const loadTimingWithTimeline = billing.status === 'complete'
                ? buildMobileLoadTiming({
                    schedule,
                    usage,
                    now,
                    timezone: site.timezone,
                    cycleEnd,
                    energyDataThrough,
                    hasTariffs: site.tariffs.length > 0,
                    hasRevision: Boolean(revision),
                })
                : null;

            return NextResponse.json({
                version: MOBILE_DASHBOARD_CONTRACT_VERSION,
                ...(revision ? { revision } : {}),
                site: { id: site.id, name: site.name, timezone: site.timezone },
                currentBill: {
                    status:billing.status,
                    estimatedCost,
                    currency: currencyCode || 'USD',
                    cycleStart: cycleStart.toISOString(),
                    cycleEnd: cycleEnd.toISOString(),
                    periods,
                },
                loadTiming: loadTimingWithTimeline,
                ...(tariffReattribution ? { tariffReattribution } : {}),
                ...(includeOutlook ? { outlook: billing.status === 'complete' && billing.value.outlook ? {
                    ...billing.value.outlook,
                    tariffTimeline: buildLoadTimingTimeline(schedule, new Date(billing.value.outlook.observedThrough),
                        cycleEnd, new Date(Math.min(+now, +cycleEnd))).map(segment => {
                        const match = schedule.getTariffPeriod(new Date(segment.start));
                        return { ...segment, tariffName: match?.tariff.name || 'Unknown',
                            periodName: match?.schedule.name || 'Unknown' };
                    }),
                } : null } : {}),
                sources: {
                    calculatedAt: now.toISOString(),
                    energyDataThrough: energyDataThrough?.toISOString() ?? null,
                },
            }, { headers: PRIVATE_RESPONSE });
        } catch (error) {
            console.error('[mobile-bill-summary] request failed:', error);
            return NextResponse.json({ error: 'Failed to fetch mobile bill summary' }, { status: 500 });
        }
    });
}
