import { Temporal } from '@js-temporal/polyfill';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { getCurrentCycleStart, getSiteLocalDate, addMonthsInSiteTimezone } from '@/lib/billing-cycle';

import { BillSummary } from '@/components/BillSummary';
import { BillDateNav } from '@/components/BillDateNav';
import { DataSyncer } from '@/components/DataSyncer';

import { PageBreadcrumbs } from '@/components/PageBreadcrumbs';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';

export const dynamic = 'force-dynamic';

export default async function UsagePage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ date?: string; start?: string; end?: string }>;
}) {
    const { id } = await params;
    const { date: queryDate, start: queryStart, end: queryEnd } = await searchParams;
    const siteRepo = new SiteRepo();
    const repo = new EnergyRepo();


    const site = await siteRepo.getSite(id);
    if (!site) {
        return (
            <PageShell maxWidth="2xl" className="space-y-6">
                <PageHeader title="Estimated Monthly Bill" density="compact" />
                <SectionCard density="compact">
                    <p className="text-sm text-gray-600 dark:text-gray-300">Site not found.</p>
                </SectionCard>
            </PageShell>
        );
    }

    // Determine start/end dates
    let start: Date;
    let end: Date;
    let isCustomRange = false;

    if (queryStart && queryEnd) {
        // Custom Range Mode
        const [sy, sm, sd] = queryStart.split('-').map(Number);
        const [ey, em, ed] = queryEnd.split('-').map(Number);

        // Parse dates as site-local time, convert to UTC instant at midnight.
        start = getSiteLocalDate(sy, sm, sd, site.timezone);

        // For end date: repo.getUsageByTOU expects exclusive upper bound.
        // If user picks "Dec 11" as end date, they mean "Include Dec 11".
        // So we set end to Dec 12 00:00 UTC.
        end = getSiteLocalDate(ey, em, ed, site.timezone);
        end = new Date(end.getTime() + 24 * 60 * 60 * 1000);

        isCustomRange = true;
    } else if (queryDate) {
        // Specific Billing Cycle Mode
        const [y, m, d] = queryDate.split('-').map(Number);
        start = getSiteLocalDate(y, m, d, site.timezone);

        // Calculate end as one month later (same day, next month).
        // Use 35-day pivot to ensure we land in the next month, then getSiteLocalDate
        // to get the correct midnight in the site's timezone.
        const nextMonthPivot = new Date(start.getTime() + 35 * 24 * 60 * 60 * 1000);
        const instant = Temporal.Instant.from(nextMonthPivot.toISOString());
        const zonedDate = instant.toZonedDateTimeISO(site.timezone);
        end = getSiteLocalDate(zonedDate.year, zonedDate.month, d, site.timezone);
    } else {
        // Default to Current Billing Cycle (computed in the site's timezone).
        const now = new Date();
        start = getCurrentCycleStart(site.billing_start_day, now, site.timezone);
        // End = next cycle start. Pivot 35 days forward (always lands in the next month)
        // so the +1-month math goes through the same tz-aware helper.
        const nextMonthPivot = new Date(start.getTime() + 35 * 24 * 60 * 60 * 1000);
        end = getCurrentCycleStart(site.billing_start_day, nextMonthPivot, site.timezone);
    }

    const siteJson = site.json as import('@/lib/tesla-client').EnergySiteInfo | null;
    const currencyCode = siteJson?.tariff_content_v2?.currency || 'USD';
    let currencySymbol = '$';
    if (currencyCode === 'GBP') {
        currencySymbol = '£';
    } else if (currencyCode === 'EUR') {
        currencySymbol = '€';
    }

    const usage = await repo.getUsageByTOU(id, start, end);

    // Convert UTC instant to site-local date components for display
    const getSiteLocalComponents = (utcDate: Date) => {
        const instant = Temporal.Instant.from(utcDate.toISOString());
        const zoned = instant.toZonedDateTimeISO(site.timezone);
        return {
            year: zoned.year,
            month: zoned.month,
            day: zoned.day
        };
    };

    // Format dates using site-local date components (for URLs and display)
    const fmtDate = (d: Date) => {
        const { year, month, day } = getSiteLocalComponents(d);
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    };

    // Recalculate end display date (inclusive) for UI label
    // If end is Dec 12 00:00, we want to display Dec 11.
    const displayEnd = new Date(end);
    displayEnd.setDate(displayEnd.getDate() - 1);

    // Previous and Next month links (only relevant for non-custom)
    // Use timezone-aware month arithmetic to handle sites east of UTC correctly
    const prevDate = addMonthsInSiteTimezone(start, -1, site.timezone);
    const nextDate = addMonthsInSiteTimezone(start, 1, site.timezone);


    // Check if next month would be in the future
    const currentDate = new Date();
    // For custom range, "Current Period" check is less relevant for "Next" button logic,
    // but useful for avoiding future dates generally?
    const isCurrentPeriod = !isCustomRange && (currentDate >= start && currentDate < end);

    const getDisplayLabel = (d: Date, includeYear: boolean) => {
        const mNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const { year, month, day } = getSiteLocalComponents(d);
        if (includeYear) return `${mNames[month - 1]} ${day}, ${year}`;
        return `${mNames[month - 1]} ${day}`;
    };

    const dateRangeLabel = `${getDisplayLabel(start, false)} - ${getDisplayLabel(displayEnd, true)}`;

    // Usage Page is always viewing "full bill", so current val matches start
    const startLocal = getSiteLocalComponents(start);
    const currentMonthVal = `${startLocal.year}-${String(startLocal.month).padStart(2, '0')}`;
    const fullBillDateStr = `${startLocal.year}-${String(startLocal.month).padStart(2, '0')}-${String(site.billing_start_day || 1).padStart(2, '0')}`;

    return (
        <PageShell
            maxWidth="2xl"
            padding="none"
            className="px-4 py-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6"
        >
            <div className="space-y-6 sm:space-y-8">
                <PageBreadcrumbs items={[
                    { label: site.name, href: `/site/${id}` },
                    { label: 'Usage' }
                ]} />

                <PageHeader
                    title="Estimated Monthly Bill"
                    density="compact"
                    actions={(
                        <BillDateNav
                        siteId={id}
                        billingDay={site.billing_start_day || 1}
                        prevDateStr={fmtDate(prevDate)}
                        nextDateStr={fmtDate(nextDate)}
                        isCurrentPeriod={isCurrentPeriod}
                        dateRangeLabel={dateRangeLabel}
                        currentMonthVal={currentMonthVal}
                        fullBillDateStr={fullBillDateStr}
                        isCustomRange={isCustomRange}
                        customStart={isCustomRange ? fmtDate(start) : undefined}
                        customEnd={isCustomRange ? fmtDate(displayEnd) : undefined}
                        />
                    )}
                />

                <DataSyncer siteId={id} start={start} end={end} viewDate={start} />

                <BillSummary usage={usage} currencySymbol={currencySymbol} />
            </div>
        </PageShell>
    );
}
