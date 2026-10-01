import { SiteRepo } from '@/lib/site-repo';
import { SiteService } from '@/lib/site-service';
import { cookies } from 'next/headers';
import Link from 'next/link';

import { HistoryAvailabilityNotice } from '@/components/history-availability-notice';
import { BillSummary } from '@/components/BillSummary';
import { DataSyncer } from '@/components/DataSyncer';
import { redirect } from 'next/navigation';
import { SiteSetup } from '@/components/SiteSetup';
import { BillDateNav } from '@/components/BillDateNav';

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

    const cookieStore = await cookies();
    const siteAuthToken = cookieStore.get('site_auth')?.value;
    const siteRepo = new SiteRepo();
    const siteService = new SiteService({
        siteRepo,
        siteAuthToken
    });

    const result = await siteService.loadSitePageData(id, queryDate);

    if (result.status === 'unauthorized') {
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

    if (result.status === 'auth-failure') {
        console.log('Redirecting to login due to auth failure...');
        redirect('/login');
    }

    if (result.status === 'not-found') {
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

    if (result.status === 'needs-setup') {
        return <SiteSetup siteId={id} />;
    }

    const {
        site,
        installation,
        billingDay,
        prevDateStr,
        nextDateStr,
        isCurrentPeriod,
        dateRangeLabel,
        currentMonthVal,
        fullBillDateStr,
        usage,
        activeTariffId,
        activeTouName,
        currencySymbol,
        dateStr,
        start,
        end,
        refDate,
        historyAvailability, earliestDate, earliestMonth, canGoPrevious
    } = result;

    return (
        <PageShell maxWidth="7xl" padding="compact">
            <PageHeader
                title={site.name}
                description="Monitor history, billing, and settings for this site."
                className="mb-4"
            />
            {historyAvailability.status !== 'unavailable' && <DataSyncer siteId={id} start={new Date(Math.max(start.getTime(), new Date(historyAvailability.availableFrom).getTime()))} end={end} viewDate={refDate} />}

            <SiteTabs
                historySlot={
                    <HistoryView
                        chartNavSlot={null}
                        analysisSlot={
                            <LoadAnalysisClientPage
                                key={id}
                                availableFrom={historyAvailability.availableFrom}
                                siteId={id}
                                siteName={site.name}
                                defaultDate={dateStr}
                                siteTimezone={site.timezone}
                                displayMode={site.timezone_display_mode || 'SITE'}
                            />
                        }
                    />
                }
                billSlot={
                    <EstimatedBillView
                        billNavSlot={
                            <BillDateNav
                                siteId={id}
                                earliestDate={earliestDate}
                                earliestMonth={earliestMonth}
                                canGoPrevious={canGoPrevious}
                                billingDay={billingDay}
                                prevDateStr={prevDateStr}
                                nextDateStr={nextDateStr}
                                isCurrentPeriod={isCurrentPeriod}
                                dateRangeLabel={dateRangeLabel}
                                currentMonthVal={currentMonthVal}
                                fullBillDateStr={fullBillDateStr}
                            />
                        }
                        billSummarySlot={
                            <>
                            <HistoryAvailabilityNotice availability={historyAvailability} timezone={site.timezone} />
                            {historyAvailability.status !== 'unavailable' && <BillSummary usage={usage} activeTariffId={activeTariffId} activeTouName={activeTouName} currencySymbol={currencySymbol} />}
                            </>
                        }
                    />
                }
                settingsSlot={
                    <SettingsView site={site} installation={installation} />
                }
            >
                {/* Fallback or shared content could go here if needed */}
            </SiteTabs>
        </PageShell>
    );
}
