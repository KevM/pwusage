import { requiresTeslaReconnect } from '@/lib/tesla-refresh-outcome';
import { getSiteConnectionTokens } from '@/lib/tesla-client-factory';
import { getCurrentUser } from '@/lib/auth-checks';
import { TariffTimelineRepo } from '@/lib/tariff-timeline-repo';
import { UserRepo } from '@/lib/user-repo';
import { observePage, setLogContext } from '@/lib/observability';
import { SiteRepo } from '@/lib/site-repo';
import { SiteService } from '@/lib/site-service';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { BillSummary } from '@/components/BillSummary';
import { pricePreviewBill } from '@/lib/bill-pricing-wasm';
import { DataSyncer } from '@/components/DataSyncer';
import { SiteSetup } from '@/components/SiteSetup';
import { BillDateNav } from '@/components/BillDateNav';

import { SiteTabs } from '@/components/site/SiteTabs';
import { EstimatedBillView } from '@/components/site/EstimatedBillView';
import { LazyHistoryTab, LazySettingsView } from '@/components/site/SiteTabPanels';
import { parseSiteTab, type SiteTabId } from '@/lib/site-tabs';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageShell } from '@/components/ui/PageShell';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionCard } from '@/components/ui/SectionCard';

export const dynamic = 'force-dynamic';

/** Settings-only reads: member emails and the rate plan timeline (several sequential queries). */
async function loadSettingsTabData(siteId: string) {
    const [memberEmails, currentUser] = await Promise.all([
        new UserRepo().getSiteMemberEmails(siteId),
        getCurrentUser(),
    ]);
    const tariffTimeline = await new TariffTimelineRepo().getTimeline(siteId, currentUser?.id ?? null);
    return { memberEmails, tariffTimeline };
}

export default observePage('/site/[id]', async function SitePage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ date?: string; view?: string; billPricing?: string }>;
}) {
    const { id } = await params;
    setLogContext({ siteId: id });
    const { date: queryDate, view, billPricing } = await searchParams;
    // The selected tab decides which reads run and which client code loads.
    const activeTab: SiteTabId = parseSiteTab(view);

    const cookieStore = await cookies();
    const siteAuthToken = cookieStore.get('site_auth')?.value;
    const siteRepo = new SiteRepo();
    const siteService = new SiteService({
        siteRepo,
        siteAuthToken
    });

    const result = await siteService.loadSitePageData(id, queryDate, { view: activeTab });

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
        installations,
        billingDay,
        prevDateStr,
        nextDateStr,
        isCurrentPeriod,
        dateRangeLabel,
        currentMonthVal,
        fullBillDateStr,
        usage,
        historyRevision,
        activeTariffId,
        activeTouName,
        currencySymbol,
        dateStr,
        start,
        end,
        refDate
    } = result;

    const [connection, settingsData] = await Promise.all([
        getSiteConnectionTokens(id),
        activeTab === 'settings' ? loadSettingsTabData(id) : Promise.resolve(null),
    ]);
    const reconnectRequired = !connection || requiresTeslaReconnect(connection);

    let tabContent: ReactNode;
    if (activeTab === 'history') {
        tabContent = (
            <LazyHistoryTab
                siteId={id}
                siteName={site.name}
                defaultDate={dateStr}
                siteTimezone={site.timezone}
                displayMode={site.timezone_display_mode || 'SITE'}
            />
        );
    } else if (activeTab === 'settings') {
        tabContent = (
            <LazySettingsView
                site={site}
                installations={installations ?? []}
                memberEmails={settingsData?.memberEmails ?? []}
                tariffTimeline={settingsData?.tariffTimeline ?? null}
            />
        );
    } else {
        const pricedUsage = await pricePreviewBill(usage ?? [], billPricing);
        tabContent = (
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
                    <BillSummary usage={pricedUsage} activeTariffId={activeTariffId} activeTouName={activeTouName} currencySymbol={currencySymbol} />
                }
            />
        );
    }

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
            </Alert> : <DataSyncer siteId={id} start={start} end={end} viewDate={refDate} historyRevision={historyRevision} />}

            <SiteTabs activeTab={activeTab}>
                {tabContent}
            </SiteTabs>
        </PageShell>
    );
});
