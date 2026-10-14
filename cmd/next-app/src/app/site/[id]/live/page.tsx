import {readLiveBillingAvailability} from '@/lib/billing-availability';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { EnergyRepo, sumTodayRows } from '@/lib/energy-repo';
import { BatteryHoldRepo } from '@/lib/battery-hold-repo';
import { SiteRepo } from '@/lib/site-repo';
import { Schedule } from '@/lib/schedule';
import { verifySiteAccess, getCurrentUser } from '@/lib/auth-checks';
import { getCurrentCycleStart } from '@/lib/billing-cycle';
import { LiveDetailView } from '@/components/site/live/LiveDetailView';
import type { ActivePeriod } from '@/components/site/live/PeriodCardRow';
import { buildSnapshotModel, buildCumulativeModel } from '@/lib/sankey/build-flow-model';
import { getRenderer } from '@/lib/sankey/renderers/registry';
import { computeLoadTiming } from '@/lib/load-timing';
import { refreshTodayData, refreshLiveStatus } from '@/lib/today-refresh';
import { energyToAveragePower } from '@/lib/energy-utils';
import { PageBreadcrumbs } from '@/components/PageBreadcrumbs';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';

export const dynamic = 'force-dynamic';

export default async function SiteLivePage({
    params,
    searchParams
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ action?: string }>;
}) {
    const { id } = await params;

    const hasAccess = await verifySiteAccess(id);
    if (!hasAccess) {
        const user = await getCurrentUser();
        if (!user) {
            const { action } = await searchParams;
            const callback = `/site/${id}/live` + (action ? `?action=${action}` : '');
            redirect(`/login?callback=${encodeURIComponent(callback)}`);
        }

        return (
            <PageShell maxWidth="xl" className="flex items-center justify-center">
                <SectionCard className="w-full" title="Unauthorized" description="You do not have permission to view this site.">
                    <div className="space-y-4">
                        <Alert variant="danger">
                            <AlertTitle>Access denied</AlertTitle>
                            <AlertDescription>Your account is not authorized for this site.</AlertDescription>
                        </Alert>
                        <Link href="/products"><Button variant="outline">Return to My Products</Button></Link>
                    </div>
                </SectionCard>
            </PageShell>
        );
    }

    const siteRepo = new SiteRepo();
    const holdRepo = new BatteryHoldRepo();
    const site = await siteRepo.getSite(id);

    if (!site) {
        return (
            <PageShell maxWidth="xl">
                <SectionCard title="Site not found"><p className="text-sm">No site exists for the given id.</p></SectionCard>
            </PageShell>
        );
    }

    const repo = createEnergyRepo(site.timezone);
    const now = new Date();
    const cycleStart = getCurrentCycleStart(site.billing_start_day, now, site.timezone);
    const todayStart = EnergyRepo.getSiteMidnight(now, site.timezone);

    // Pull today's data from Tesla into the DB before reading totals. Trmnl
    // does this every poll; the live page needs the same so "Today so far"
    // isn't blank when no Trmnl device is driving the refresh. Throttled and
    // bounded — failures fall through to whatever's already in the DB.
    const refreshResult = await refreshTodayData(id);
    if (refreshResult.status === 'error') {
        console.warn(`[SiteLivePage] today refresh failed for ${id}: ${refreshResult.errorMessage}`);
    }

    const hasTariff = (site.tariffs?.length ?? 0) > 0;
    let activePeriod: ActivePeriod | null = null;
    let schedule: Schedule | null = null;
    if (hasTariff) {
        schedule = new Schedule(site.tariffs, site.timezone);
        const tp = schedule.getTariffPeriod(now);
        if (tp) {
            activePeriod = {
                name: tp.schedule.name ?? 'Unknown',
                buyRate: tp.schedule.buy_rate ?? 0,
                sellRate: tp.schedule.sell_rate ?? 0
            };
        } else {
            console.warn(`[SiteLivePage] Schedule.getTariffPeriod returned null for site ${id} at ${now.toISOString()}`);
        }
    }

    const [billing, todayChartRows, rawEnergyRows, latestEnergyData, liveStatus, activeHold, activeNotice] = await Promise.all([
        readLiveBillingAvailability(()=>repo.getCycleAndTodayTotals(id, cycleStart, todayStart, now),()=>repo.getUsageByTOU(id,todayStart,now)),
        repo.getBucketedEnergyData(id, todayStart, now),
        repo.getRawEnergyData(id, todayStart, now),
        repo.getLatestEnergyData(id),
        refreshLiveStatus(id, { cacheTtlMs: 60 * 1000 }).then(res => res.liveStatus ?? null).catch(() => null),
        holdRepo.getActiveHold(id),
        holdRepo.getLatestCancelledUnacked(id),
    ]);

    const {cycle,today}=billing;
    const todayTotals = sumTodayRows(rawEnergyRows);

    const loadTiming = billing.cycleStatus==='complete' && schedule
        ? computeLoadTiming(schedule, cycle, now, site.timezone, activePeriod)
        : null;

    // Sankey value-flow models (only when we have a tariff for rates + some live data).
    let sankeySnapshotSvg: string | null = null;
    let sankeyCumulativeSvg: string | null = null;
    if (hasTariff && activePeriod) {
        const renderer = getRenderer(site.sankey_renderer);
        const rates = { buyRate: activePeriod.buyRate, sellRate: activePeriod.sellRate };

        const snapshot = buildSnapshotModel(
            {
                solar: (liveStatus?.solar_power ?? 0) / 1000,
                load: (liveStatus?.load_power ?? 0) / 1000,
                battery: (liveStatus?.battery_power ?? 0) / 1000,
                grid: (liveStatus?.grid_power ?? 0) / 1000,
            },
            { ...rates, timestamp: now, soc: liveStatus?.percentage_charged ?? undefined },
        );

        const cumulative = buildCumulativeModel(rawEnergyRows, {
            ...rates,
            timestamp: now,
            rangeStart: todayStart,
        });

        sankeySnapshotSvg = renderer(snapshot, 'color');
        sankeyCumulativeSvg = renderer(cumulative, 'color');
    }

    return (
        <PageShell maxWidth="2xl" padding="none" className="px-4 py-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="space-y-6">
                <PageBreadcrumbs items={[{ label: site.name, href: `/site/${id}` }, { label: 'Live' }]} />
                <PageHeader title="Live detail" density="compact" />
                <LiveDetailView
                    siteId={id}
                    siteName={site.name}
                    siteTimezone={site.timezone}
                    batterySoC={liveStatus?.percentage_charged ?? latestEnergyData?.batterySoc ?? null}
                    batteryPower={liveStatus?.battery_power ?? (latestEnergyData !== null ? energyToAveragePower(latestEnergyData.batteryPower) : 0)}
                    solarPower={liveStatus?.solar_power ?? (latestEnergyData !== null ? energyToAveragePower(latestEnergyData.solarPower) : 0)}
                    gridPower={liveStatus?.grid_power ?? (latestEnergyData !== null ? energyToAveragePower(latestEnergyData.gridPower) : 0)}
                    loadPower={liveStatus?.load_power ?? (latestEnergyData !== null ? energyToAveragePower(latestEnergyData.loadPower) : 0)}
                    today={today}
                    todayPricingUnavailable={billing.todayStatus!=='complete'}
                    cyclePricingUnavailable={billing.cycleStatus!=='complete'}
                    todayTotals={todayTotals}
                    todayChartRows={todayChartRows}
                    todayStart={todayStart}
                    now={now}
                    hasTariff={hasTariff}
                    loadTiming={loadTiming}
                    batteryHold={activeHold ? {
                        mode: activeHold.mode,
                        target_reserve: activeHold.target_reserve,
                        original_reserve: activeHold.original_reserve,
                        created_at: activeHold.created_at.toISOString(),
                        safety_expires_at: activeHold.safety_expires_at.toISOString(),
                    } : null}
                    batteryNotice={activeNotice ? { current: activeNotice.cancelled_observed_reserve ?? activeNotice.target_reserve } : null}
                    sankeySnapshotSvg={sankeySnapshotSvg}
                    sankeyCumulativeSvg={sankeyCumulativeSvg}
                />
            </div>
        </PageShell>
    );
}
