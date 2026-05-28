import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { TeslaTokenRepo } from '@/lib/tesla-token-repo';
import Link from 'next/link';


import { BillSummary } from '@/components/BillSummary';

import { DataSyncer } from '@/components/DataSyncer';

import { TeslaClient } from '@/lib/tesla-client';
import { Schedule } from '@/lib/schedule';
import { Importer } from '@/lib/importer';
import { redirect } from 'next/navigation';
import { SiteSetup } from '@/components/SiteSetup';
import { BillDateNav } from '@/components/BillDateNav';


import { verifySiteAccess } from '@/lib/auth-checks';
import { TrmnlService } from '@/lib/trmnl-service';
import { LoginSuccessTracker } from '@/components/LoginSuccessTracker';
import { SiteTabs } from '@/components/site/SiteTabs';
import { HistoryView } from '@/components/site/HistoryView';
import { EstimatedBillView } from '@/components/site/EstimatedBillView';
import { SettingsView } from '@/components/site/SettingsView';
import LoadAnalysisClientPage from '@/components/LoadAnalysisClientPage';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageShell } from '@/components/ui/PageShell';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionCard } from '@/components/ui/SectionCard';

export const dynamic = 'force-dynamic';

export default async function SitePage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ date?: string; view?: string }>;
}) {
    const { id } = await params;
    const { date: queryDate } = await searchParams;
    const siteRepo = new SiteRepo();
    const repo = new EnergyRepo();
    const tokenRepo = new TeslaTokenRepo(siteRepo);
    let site = await siteRepo.getSite(id, { includeTokens: true });

    const hasAccess = await verifySiteAccess(id);
    if (!hasAccess) {
        return (
            <PageShell maxWidth="xl" className="flex items-center justify-center">
                <SectionCard
                    className="w-full"
                    title="Unauthorized"
                    description="You do not have permission to view this site."
                >
                    <div className="space-y-4">
                        <Alert variant="danger">
                            <AlertTitle>Access denied</AlertTitle>
                            <AlertDescription>
                                Your account is not authorized for this site.
                            </AlertDescription>
                        </Alert>
                        <Link href="/products">
                            <Button variant="outline">Return to My Products</Button>
                        </Link>
                    </div>
                </SectionCard>
            </PageShell>
        );
    }

    // 1. Get tokens from DB
    const accessToken = site?.access_token;
    const refreshToken = site?.refresh_token;

    const handlers = tokenRepo.getLockedRefreshHandler(id);
    const teslaClient = new TeslaClient({
        accessToken: accessToken!,
        refreshToken: refreshToken!, // Type assertion as we expect valid sites to have tokens
        tokenRefreshHandler: handlers.refreshHandler,
        onTokenError: handlers.errorHandler,
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
        if ((error as Error).message && ((error as Error).message.includes('401') || (error as Error).message.includes('invalid authentication') || (error as Error).message.includes('Tesla API Error: 401'))) {
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

    const finalSite = await siteRepo.getSite(id);

    if (!finalSite) {
        return (
            <PageShell maxWidth="xl" className="flex items-center justify-center">
                <SectionCard
                    className="w-full"
                    title="Site Not Found"
                    description="We could not find a site for the selected id."
                >
                    <div>
                        <Link href="/products">
                            <Button variant="outline">Back to Products</Button>
                        </Link>
                    </div>
                </SectionCard>
            </PageShell>
        );
    }

    // If new site, BLOCK everything else and show setup wizard
    if (!hasData) {
        return <SiteSetup siteId={id} />;
    }

    const siteJson = finalSite.json as import('@/lib/tesla-client').EnergySiteInfo | null;
    const currencyCode = siteJson?.tariff_content_v2?.currency || 'USD';
    let currencySymbol = '$';
    if (currencyCode === 'GBP') {
        currencySymbol = '£';
    } else if (currencyCode === 'EUR') {
        currencySymbol = '€';
    }

    // Live stats fetch removed as it was unused


    // Get hourly data for the requested date (from query param) or today (in site timezone)
    // We must use the Site's Time to determine "Today", otherwise
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

    // Calculate period based on billing start day
    const billingDay = finalSite.billing_start_day || 1;

    // Determine reference date: queryDate or siteNow
    // We treat queryDate as a Site-local date for the site.
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
    // Since we know 'start' year/month/billingDay match the intended Site Time.
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

    // Additional Fetch for Settings View (Trmnl)
    // We explicitly do NOT include tokens here as they are passed to a client component
    const trmnlService = new TrmnlService();
    const installation = await trmnlService.getInstallationBySiteId(finalSite.id, { includeTokens: false });

    return (
        <>
            <LoginSuccessTracker />
            <PageShell maxWidth="7xl" padding="compact">
                <PageHeader
                    title={finalSite.name}
                    description="Monitor history, billing, and settings for this site."
                    className="mb-4"
                />
            <DataSyncer siteId={id} start={start} end={end} viewDate={refDate} />

            <SiteTabs
                historySlot={
                    <HistoryView
                        chartNavSlot={null}
                        analysisSlot={
                            <LoadAnalysisClientPage
                                siteId={id}
                                siteName={finalSite.name}
                                defaultDate={dateStr}
                                siteTimezone={finalSite.timezone}
                                displayMode={finalSite.timezone_display_mode || 'SITE'}
                            />
                        }
                    />
                }
                billSlot={
                    <EstimatedBillView
                        billNavSlot={
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
                        }
                        billSummarySlot={
                            <BillSummary usage={usage} activeTariffId={activeTariffId} activeTouName={activeTouName} currencySymbol={currencySymbol} />
                        }
                    />
                }
                settingsSlot={
                    <SettingsView site={finalSite} installation={installation} />
                }
            >
                {/* Fallback or shared content could go here if needed */}
                </SiteTabs>
            </PageShell>
        </>
    );
}
