import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { EnergyRepo } from '@/lib/energy-repo';
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
import { readLiveTodayHistory, storedLiveReading } from '@/lib/live-page-data';
import { refreshLivePage } from '@/lib/live-page-refresh';
import { RefreshWhenChanged } from '@/components/site/live/RefreshWhenChanged';
import { energyToAveragePower } from '@/lib/energy-utils';
import { PageBreadcrumbs } from '@/components/PageBreadcrumbs';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';

export const dynamic = 'force-dynamic';

/**
 * Fetches fresh Tesla data after the stored snapshot has streamed, then
 * re-renders the open page once if anything new was stored.
 */
async function LiveDataRefresh({ siteId }: { siteId: string }) {
    const { changed } = await refreshLivePage(siteId);
    // A fresh id per server render, so each later refresh can apply its own change.
    return <RefreshWhenChanged changed={changed} cycle={randomUUID()} />;
}

function ReadingsAsOf({ asOf, timezone, checking }: { asOf: Date | null; timezone: string; checking: boolean }) {
    const time = asOf
        ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(asOf)
        : null;
    const parts = [time ? `Readings as of ${time}.` : 'No readings stored yet.', checking ? 'Checking Tesla for newer readings.' : null];
    return <p role="status" className="text-xs text-gray-500 dark:text-gray-400">{parts.filter(Boolean).join(' ')}</p>;
}

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

    // Render the stored, timestamped snapshot right away. Fresh Tesla data
    // (today's samples and the live reading) is fetched by <LiveDataRefresh>,
    // streamed after this content, which re-renders the page if it stored
    // anything new. Trmnl and the mobile app drive the same throttled refresh.

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

    // One decoded read of today's samples feeds billing, the chart and the totals.
    const [todayHistory, latestEnergyData, activeHold, activeNotice] = await Promise.all([
        readLiveTodayHistory(repo, id, cycleStart, todayStart, now),
        repo.getLatestEnergyData(id),
        holdRepo.getActiveHold(id),
        holdRepo.getLatestCancelledUnacked(id),
    ]);
    const { billing, todayChartRows, todayRows: rawEnergyRows, todayTotals } = todayHistory;
    const reading = storedLiveReading(site, latestEnergyData, now);
    const liveStatus = reading.liveStatus;

    const {cycle,today}=billing;

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
                <Suspense fallback={<ReadingsAsOf asOf={reading.asOf} timezone={site.timezone} checking />}>
                    <ReadingsAsOf asOf={reading.asOf} timezone={site.timezone} checking={false} />
                    <LiveDataRefresh siteId={id} />
                </Suspense>
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
