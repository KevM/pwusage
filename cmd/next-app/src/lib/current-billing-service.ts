import { readBillingAvailability } from '@/lib/billing-availability';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { SiteRepo } from '@/lib/site-repo';
import { getCurrentCycleStart, getNextCycleStart } from '@/lib/billing-cycle';
import { MOBILE_DASHBOARD_CONTRACT_VERSION, type MobileBillSummary } from '@/lib/mobile-dashboard-contract';
import { buildMobileLoadTiming, summarizeBillUsage } from '@/lib/mobile-bill-summary';
import { Schedule } from '@/lib/schedule';
import { buildLoadTimingTimeline } from '@/lib/load-timing-timeline';
import { matchesMobileBillConfiguration, readCurrentMobileSite, readMobileBillConfiguration, readMobileBillRevision } from '@/lib/mobile-bill-revision';
import { getSiteReattributionStatus } from '@/lib/tariff-reattribution';
import { refreshTodayData } from '@/lib/today-refresh';
import { logEvent } from '@/lib/observability';

const BILLING_STALE_AFTER_MS = 60 * 60 * 1000;
const BILLING_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type CurrentBillingResult =
    | { status: 'not-found' }
    | { status: 'unchanged'; revision: string; energyDataThrough: Date | null }
    | { status: 'current'; summary: MobileBillSummary; revision?: string; energyDataThrough: Date | null };

export async function readCurrentBilling(siteId: string, {
    includeOutlook = false,
    acceptRevision,
    refreshStale = false,
}: {
    includeOutlook?: boolean;
    acceptRevision?: (revision: string, energyDataThrough?: Date | null) => boolean;
    refreshStale?: boolean;
}): Promise<CurrentBillingResult> {
    const siteRepo = new SiteRepo();
    const { site, config: currentConfig } = acceptRevision !== undefined
        ? await readCurrentMobileSite(siteRepo, siteId)
        : { site: await siteRepo.getSite(siteId), config: null };
    if (!site) return { status: 'not-found' };

    const energyRepo = createEnergyRepo(site.timezone);
    let energyDataThrough: Date | null | undefined;
    if (refreshStale) {
        energyDataThrough = await energyRepo.getLatestTimestamp(siteId);
        if (!energyDataThrough || Date.now() - +energyDataThrough > BILLING_STALE_AFTER_MS) {
            const ageMs = energyDataThrough ? Date.now() - +energyDataThrough : null;
            const refresh = await refreshTodayData(siteId, { minIntervalMs: BILLING_REFRESH_INTERVAL_MS });
            logEvent('info', 'integration.billing.refresh', { status: refresh.status, ageMs });
            energyDataThrough = await energyRepo.getLatestTimestamp(siteId);
        }
    }
    const now = new Date();
    const billingDay = site.billing_start_day || 1;
    const cycleStart = getCurrentCycleStart(billingDay, now, site.timezone);
    const cycleEnd = getNextCycleStart(billingDay, cycleStart, site.timezone);
    const schedule = new Schedule(site.tariffs, site.timezone);
    const beforeReattribution = currentConfig ? await getSiteReattributionStatus(siteId) : undefined;
    const before = currentConfig
        ? await readMobileBillRevision(site, currentConfig, schedule, cycleStart, cycleEnd, now, includeOutlook, beforeReattribution)
        : null;
    if (before && acceptRevision?.(before, energyDataThrough)) {
        return { status: 'unchanged', revision: before, energyDataThrough: energyDataThrough ?? null };
    }
    const [billing, currencyCode, latest, fetchedReattribution] = await Promise.all([
        readBillingAvailability(async () => includeOutlook
            ? energyRepo.getBillOutlook(siteId, cycleStart, cycleEnd)
            : { usage: await energyRepo.getUsageByTOU(siteId, cycleStart, cycleEnd), outlook: null },
            { usage: [], outlook: null }),
        currentConfig ? Promise.resolve(currentConfig.currency) : siteRepo.getSiteCurrencyCode(siteId),
        energyDataThrough === undefined ? energyRepo.getLatestTimestamp(siteId) : Promise.resolve(energyDataThrough),
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
            console.warn('[current-billing] revision check failed:', error);
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
            energyDataThrough: latest,
            hasTariffs: site.tariffs.length > 0,
            hasRevision: includeOutlook && Boolean(revision),
        })
        : null;

    const summary: MobileBillSummary = {
        version: MOBILE_DASHBOARD_CONTRACT_VERSION,
        ...(includeOutlook && revision ? { revision } : {}),
        site: { id: site.id, name: site.name, timezone: site.timezone },
        currentBill: {
            status: billing.status,
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
            energyDataThrough: latest?.toISOString() ?? null,
        },
    };
    return { status: 'current', summary, revision, energyDataThrough: latest };
}
