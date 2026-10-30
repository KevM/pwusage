import { requiresTeslaReconnect } from '@/lib/tesla-refresh-outcome';
import { UserRepo } from '@/lib/user-repo';
import { observePage, setLogContext } from '@/lib/observability';
import { SiteRepo } from '@/lib/site-repo';
import { SiteService } from '@/lib/site-service';
import { cookies } from 'next/headers';
import Link from 'next/link';

import { BillSummary } from '@/components/BillSummary';
import { DataSyncer } from '@/components/DataSyncer';
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

export default observePage('/site/[id]', async function SitePage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ date?: string; view?: string }>;
}) {
    const { id } = await params;
    setLogContext({ siteId: id });
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
        return <PageShell><Alert><AlertTitle>Reconnect Tesla to update your data.</AlertTitle>
            <Link href={`/login?callback=${encodeURIComponent(`/site/${id}`)}`} prefetch={false}>Reconnect Tesla</Link>
        </Alert></PageShell>;
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
        refDate
    } = result;

    const connection = await new UserRepo().getTokensForSite(id);
    const reconnectRequired = !connection || requiresTeslaReconnect(connection);

    return (
        <PageShell maxWidth="7xl" padding="compact">
            <PageHeader
                title={site.name}
                description="Monitor history, billing, and settings for this site."
                className="mb-4"
            />
            {reconnectRequired ? <Alert className="mb-4">
                <AlertTitle>Reconnect Tesla to update your data.</AlertTitle>
                <AlertDescription>Stored history is still available. Check each reading’s timestamp.</AlertDescription>
                <Link href={`/login?callback=${encodeURIComponent(`/site/${id}`)}`} prefetch={false}>Reconnect Tesla</Link>
            </Alert> : <DataSyncer siteId={id} start={start} end={end} viewDate={refDate} />}

            <SiteTabs
                historySlot={
                    <HistoryView
                        chartNavSlot={null}
                        analysisSlot={
                            <LoadAnalysisClientPage
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
                            <BillSummary usage={usage} activeTariffId={activeTariffId} activeTouName={activeTouName} currencySymbol={currencySymbol} />
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
});
