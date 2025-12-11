import { EnergyRepo } from '@/lib/energy-repo';
import Link from 'next/link';
import { EnergyChartWithNav } from '@/components/EnergyChartWithNav';
import { SiteLiveStats } from '@/components/SiteLiveStats';
import { BillSummary } from '@/components/BillSummary';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { DataSyncer } from '@/components/DataSyncer';

import { TeslaClient } from '@/lib/tesla-client';
import { Schedule } from '@/lib/schedule';
import { Importer } from '@/lib/importer';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SiteSetup } from '@/components/SiteSetup';
import { BillDateNav } from '@/components/BillDateNav';

export const dynamic = 'force-dynamic';

export default async function SitePage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ date?: string }>;
}) {
    const { id } = await params;
    const { date: queryDate } = await searchParams;
    const repo = new EnergyRepo();
    let site = await repo.getSite(id);
    // We don't return early here anymore. We check tokens first to see if we can self-heal.

    // ------------------------------------------------------------------------
    // MIGRATION: Centralized Token Storage
    // ------------------------------------------------------------------------
    // 1. Try to get tokens from DB (Site table)
    let accessToken = site?.access_token;
    let refreshToken = site?.refresh_token;

    // 2. If not in DB, try to move them from cookies (Migration Step)
    const cookieStore = await cookies();
    const cookieAccess = cookieStore.get('access_token')?.value;
    const cookieRefresh = cookieStore.get('refresh_token')?.value;

    if (!accessToken && cookieAccess && cookieRefresh) {
        // If we have cookies but no DB record (or no tokens in DB), use cookies
        accessToken = cookieAccess;
        refreshToken = cookieRefresh;

        if (site) {
            console.log(`[Migration] Moving tokens from cookies to DB for site ${id}`);
            await repo.updateSiteTokens(id, cookieAccess, cookieRefresh);
        }
    }

    if (!site && !accessToken) {
        // Only error out if we have NEITHER a DB record NOR a valid cookie session
        return <div>Site not found</div>;
    }

    if (!accessToken) {
        // Force re-login if we have no tokens anywhere
        redirect('/login');
    }

    const teslaClient = new TeslaClient({
        accessToken: accessToken!,
        refreshToken: refreshToken!,
        tokenRefreshHandler: repo.getLockedRefreshHandler(id),
        onTokenUpdate: async () => {
            // This is still useful if we want to log or do side effects, 
            // but the handler updates the DB already.
            console.log('Token update callback triggered (Site Page).');
        }
    });

    const importer = new Importer(teslaClient);
    try {
        // Only run ensureSite if we don't have the site, or if we suspect it's stale/broken
        // Since AuthCallback runs ensureSite, we generally expect it to exist.
        if (!site) {
            console.log(`[SitePage] Site ${id} missing in DB, running ensureSite...`);
            const ensureResult = await importer.ensureSite(id);
            if (ensureResult) {
                site = ensureResult;
            }
        }
    } catch (error) {
        console.error('Failed to ensure site:', error);
        if ((error as Error).message && ((error as Error).message.includes('401') || (error as Error).message.includes('invalid authentication'))) {
            // ... (redirect logic)
            console.log('Redirecting to login due to auth failure...');
            redirect('/login');
        }

        // If we still don't have data, we can't proceed
        if (!await repo.hasData(id)) {
            // But wait, if ensureSite failed, maybe we *can* show SiteSetup if we have the site record?
            // If ensureSite failed, likely API error.
            throw error;
        }
    }

    // Check if new site (no data)
    const hasData = await repo.hasData(id);

    // If we have no data, it's possible the DB was wiped but the cache is stale.
    // We must ensure the site exists in the DB before proceeding.
    if (!hasData && site) {
        // Force ensure site to handle "ghost" site scenario (cached but deleted from DB)
        await importer.ensureSite(id);
    }

    const finalSite = await repo.getSite(id);

    if (!finalSite) {
        return <div>Site not found</div>;
    }

    // If new site, BLOCK everything else and show setup wizard
    if (!hasData) {
        return <SiteSetup siteId={id} />;
    }

    // Use finalSite for the rest of the render
    // ... we need to make sure we use finalSite.name instead of site.name below

    // Get live stats for initial render
    let initialStats = {
        solarPower: 0,
        loadPower: 0,
        batteryPower: 0,
        gridPower: 0,
        percentageCharged: 0,
        currentTariff: 'Unknown'
    };

    if (accessToken) {
        try {
            const liveStatus = await teslaClient.getLiveStatus(id);

            // Get current tariff
            let currentTariff = 'Unknown';
            if (finalSite.tariffs.length > 0) {
                const schedule = new Schedule(finalSite.tariffs, finalSite.timezone);
                const tariffPeriod = schedule.getTariffPeriod(new Date());
                if (tariffPeriod) {
                    const season = tariffPeriod.season.name || 'Season';
                    const tariffName = tariffPeriod.tariff.name || 'Unknown';
                    currentTariff = `${season} - ${tariffName}`;
                }
            }

            initialStats = {
                solarPower: liveStatus.solar_power,
                loadPower: liveStatus.load_power,
                batteryPower: liveStatus.battery_power,
                gridPower: liveStatus.grid_power,
                percentageCharged: liveStatus.percentage_charged,
                currentTariff
            };
        } catch (error) {
            console.error('Failed to fetch initial live stats:', error);
        }
    }

    // Get hourly data for the requested date (from query param) or today (in site timezone)
    // We must use the Site's Wall Clock Time to determine "Today", otherwise
    // Server UTC might be "Tomorrow" while Site is still "Today".
    const getSiteNow = (tz: string) => {
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const parts = fmt.format(new Date()); // YYYY-MM-DD
        const [y, m, d] = parts.split('-').map(Number);
        return new Date(y, m - 1, d); // Local Midnight Construction
    };

    const siteNow = getSiteNow(finalSite.timezone);

    let dateStr: string;

    if (queryDate) {
        dateStr = queryDate;
    } else {
        const year = siteNow.getFullYear();
        const month = String(siteNow.getMonth() + 1).padStart(2, '0');
        const day = String(siteNow.getDate()).padStart(2, '0');
        dateStr = `${year}-${month}-${day}`;
    }

    const hourlyData = await repo.getHourlyEnergyData(id, dateStr);

    // Calculate period based on billing start day
    const billingDay = finalSite.billing_start_day || 1;

    // Determine reference date: queryDate or siteNow
    // We treat queryDate as a Wall Clock date for the site.
    let refDate = siteNow;
    if (queryDate) {
        const [y, m, d] = queryDate.split('-').map(Number);
        if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
            refDate = new Date(y, m - 1, d);
        }
    }

    let startMonth = refDate.getMonth();
    const startYear = refDate.getFullYear();

    // If reference date is before the billing day, we are in the previous month's billing cycle
    if (refDate.getDate() < billingDay) {
        startMonth--;
    }

    const start = new Date(startYear, startMonth, billingDay);
    // End date is start date + 1 month
    const end = new Date(start.getFullYear(), start.getMonth() + 1, billingDay);

    const usage = await repo.getUsageByTOU(id, start, end);

    // Determine active tariff ID and TOU Name
    let activeTariffId: number | undefined;
    let activeTouName: string | undefined;
    if (finalSite.tariffs.length > 0) {
        const schedule = new Schedule(finalSite.tariffs, finalSite.timezone);
        const tariffPeriod = schedule.getTariffPeriod(new Date());
        if (tariffPeriod) {
            activeTariffId = tariffPeriod.tariff.id;
            activeTouName = tariffPeriod.schedule.name || undefined;
        }
    }

    // Navigation dates
    const prevDate = new Date(start.getFullYear(), start.getMonth() - 1, billingDay);
    const nextDate = new Date(start.getFullYear(), start.getMonth() + 1, billingDay);
    const fmtDate = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    // Format for display (Server Side to avoid browser timezone shift)


    // We want the Start Date and End Date displayed in the header.
    // NOTE: 'start' and 'end' are constructed as local midnight at server logic, 
    // but they effectively represent the billing day.
    // We can just format them.
    // However, Intl.DateTimeFormat with timeZone might shift if 'start' (created via new Date(y,m,d))
    // doesn't align with the timezone.
    // Actually, we constructed 'start' using getSiteNow logic components?
    // No, 'start' was constructed via `new Date(startYear, startMonth, billingDay)`.
    // This is "Server Local Midnight".
    // If Server is UTC, and Site is CST.
    // Nov 10 00:00 UTC -> Nov 9 18:00 CST.
    // If we format with 'timeZone: finalSite.timezone' (CST), it will print "Nov 9".
    // THIS IS THE PROBLEM.

    // We want to display the "intended" date.
    // Since we know 'start' year/month/billingDay match the intended Wall Clock date.
    // We can just construct the string manually.

    const getDisplayLabel = (d: Date, includeYear: boolean) => {
        const mNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const month = mNames[d.getMonth()];
        const day = d.getDate();
        if (includeYear) return `${month} ${day}, ${d.getFullYear()}`;
        return `${month} ${day}`;
    };

    const dateRangeLabel = `${getDisplayLabel(start, false)} - ${getDisplayLabel(end, true)}`;

    const currentMonthVal = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    const fullBillDateStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(billingDay).padStart(2, '0')}`;

    // Check if next month would be in the future
    const isCurrentPeriod = siteNow >= start && siteNow < end;

    return (
        <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="w-full max-w-6xl">
                <Breadcrumbs items={[{ label: 'Dashboard', href: '/' }, { label: finalSite.name }]} />
                <div className="flex justify-between items-center mb-4">
                    <h1 className="text-4xl font-bold">{finalSite.name}</h1>
                    <Link
                        href={`/site/${id}/settings`}
                        className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors text-gray-600 dark:text-gray-300"
                        title="Site Settings"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                    </Link>
                </div>

                <DataSyncer siteId={id} start={start} end={end} viewDate={refDate} />

                {/* Live Stats */}
                <SiteLiveStats siteId={id} initialStats={initialStats} />

                {/* Hourly Chart with Navigation */}
                <div className="mb-8">
                    <EnergyChartWithNav
                        initialData={{ date: dateStr, data: hourlyData }}
                        siteId={id}
                    />
                </div>

                <div className="flex flex-wrap justify-between items-center mb-4 gap-4">
                    <h2 className="text-2xl font-bold">Estimated Monthly Bill</h2>

                    <BillDateNav
                        siteId={id}
                        billingDay={billingDay}
                        prevDateStr={fmtDate(prevDate)}
                        nextDateStr={fmtDate(nextDate)}
                        isCurrentPeriod={isCurrentPeriod}
                        dateRangeLabel={dateRangeLabel}
                        currentMonthVal={currentMonthVal}
                        fullBillDateStr={fullBillDateStr}
                    />
                </div>

                <BillSummary usage={usage} activeTariffId={activeTariffId} activeTouName={activeTouName} />
            </div>
        </div>
    );
}
