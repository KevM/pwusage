import Link from 'next/link';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { Schedule } from '@/lib/schedule';
import { TeslaClient } from '@/lib/tesla-client';
import { verifySiteAccess } from '@/lib/auth-checks';
import { getCurrentCycleStart } from '@/lib/billing-cycle';
import { LiveDetailView } from '@/components/site/live/LiveDetailView';
import type { ActivePeriod } from '@/components/site/live/PeriodCardRow';
import {
    findNextCheaperPeriod,
    type CheaperPeriod
} from '@/lib/next-cheaper-period';
import { computeLoadTiming } from '@/lib/load-timing';
import { refreshTodayData } from '@/lib/today-refresh';
import { TeslaTokenRepo } from '@/lib/tesla-token-repo';
import { UserRepo } from '@/lib/user-repo';
import { energyToAveragePower } from '@/lib/energy-utils';
import { PageBreadcrumbs } from '@/components/PageBreadcrumbs';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';

export const dynamic = 'force-dynamic';

async function getLiveStatus(siteId: string) {
    const tokens = await new UserRepo().getTokensForSite(siteId);
    if (!tokens?.access_token || !tokens?.refresh_token) return null;

    const siteRepo = new SiteRepo();
    const tokenRepo = new TeslaTokenRepo(siteRepo);
    const handlers = tokenRepo.getLockedRefreshHandler(siteId);

    const client = new TeslaClient({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenRefreshHandler: handlers.refreshHandler,
        onTokenError: handlers.errorHandler,
        onTokenUpdate: () => {}
    });

    return client.getLiveStatus(siteId);
}

export default async function SiteLivePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const hasAccess = await verifySiteAccess(id);
    if (!hasAccess) {
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
    const repo = new EnergyRepo();
    const site = await siteRepo.getSite(id);

    if (!site) {
        return (
            <PageShell maxWidth="xl">
                <SectionCard title="Site not found"><p className="text-sm">No site exists for the given id.</p></SectionCard>
            </PageShell>
        );
    }

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

    const [{ cycle, today }, todayTotals, todayChartRows, latestEnergyData, liveStatus] = await Promise.all([
        repo.getCycleAndTodayTotals(id, cycleStart, todayStart, now),
        repo.getTodayTotals(id, todayStart, now),
        repo.getBucketedEnergyData(id, todayStart, now),
        repo.getLatestEnergyData(id),
        getLiveStatus(id).catch(() => null)
    ]);

    // Marginal-cost / next-cheaper orchestration lives in the shared
    // computeLoadTiming module so the live page and the TRMNL markup route
    // never disagree. The view consumes the full CheaperPeriod (startsAt /
    // basis), so when a cheaper period exists re-derive it once — same
    // inputs, same result, props stay identical to the prior inline logic.
    const loadTiming = schedule
        ? computeLoadTiming(schedule, cycle, now, site.timezone, activePeriod)
        : null;
    const nextCheaper: CheaperPeriod | null = (schedule && loadTiming?.nextCheaper)
        ? findNextCheaperPeriod(schedule, now, cycle, site.timezone)
        : null;
    const nextCheaperPhrase: string | null = loadTiming?.nextCheaperPhrase ?? null;
    const nextStartPhraseByKey: Record<string, string> = loadTiming?.nextStartPhraseByKey ?? {};
    const activeIsCheapest = loadTiming?.activeIsCheapest ?? false;

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
                    cycle={cycle}
                    today={today}
                    todayTotals={todayTotals}
                    todayChartRows={todayChartRows}
                    todayStart={todayStart}
                    now={now}
                    activePeriod={activePeriod}
                    hasTariff={hasTariff}
                    nextCheaper={nextCheaper}
                    nextCheaperPhrase={nextCheaperPhrase}
                    nextStartPhraseByKey={nextStartPhraseByKey}
                    activeIsCheapest={activeIsCheapest}
                />
            </div>
        </PageShell>
    );
}
