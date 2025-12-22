import { EnergyRepo } from '@/lib/energy-repo';
import { pool } from '@/lib/db';
import Link from 'next/link';
import { EnergyChartWithNav } from '@/components/EnergyChartWithNav';

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


import { verifySiteToken } from '@/lib/auth-jwt';

export const dynamic = 'force-dynamic';

export default async function SitePage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ date?: string }>;
}) {
    const { id } = await params;
    const { date: queryDate } = await searchParams;
    const repo = new EnergyRepo();
    let site = await repo.getSite(id);

    // Verify ownership via JWT
    const cookieStore = await cookies();
    const siteAuthToken = cookieStore.get('site_auth')?.value;

    if (!siteAuthToken) {
        redirect('/login');
    }

    const authorizedSites = verifySiteToken(siteAuthToken);
    if (!authorizedSites || !authorizedSites.includes(id)) {
        return (
            <div className="flex min-h-screen flex-col items-center justify-center p-8">
                <h1 className="text-2xl font-bold text-red-600 mb-4">Unauthorized</h1>
                <p className="text-gray-600 mb-6">You do not have permission to view this site.</p>
                <Link href="/products" className="text-blue-600 hover:underline">
                    Return to My Products
                </Link>
            </div>
        );
    }

    // 1. Get tokens from DB
    const accessToken = site?.access_token;
    const refreshToken = site?.refresh_token;

    const teslaClient = new TeslaClient({
        accessToken: accessToken!,
        refreshToken: refreshToken!, // Type assertion as we expect valid sites to have tokens
        tokenRefreshHandler: repo.getLockedRefreshHandler(id),
        onTokenUpdate: async () => {
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

    // Live stats fetch removed as it was unused


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

    // Site switcher logic removed as it was unused


    const breadcrumbRootLabel = (
        <Link href="/products" className="flex items-center gap-1 hover:bg-gray-100 dark:hover:bg-slate-800 px-2 py-1 rounded transition-colors group">
            <span className="font-semibold">{finalSite.name}</span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-gray-500 group-hover:text-gray-700 dark:text-gray-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
        </Link>
    );

    return (
        <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="w-full max-w-6xl">
                <Breadcrumbs items={[{ label: breadcrumbRootLabel }]} />

                <DataSyncer siteId={id} start={start} end={end} viewDate={refDate} />

                {/* Live Stats */}


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
