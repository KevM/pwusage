import { EnergyRepo } from '@/lib/energy-repo';

import { BillSummary } from '@/components/BillSummary';
import { BillDateNav } from '@/components/BillDateNav';
import { DataSyncer } from '@/components/DataSyncer';

import { Breadcrumbs } from '@/components/Breadcrumbs';

export const dynamic = 'force-dynamic';

export default async function UsagePage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ date?: string; start?: string; end?: string }>;
}) {
    const { id } = await params;
    const { date: queryDate, start: queryStart, end: queryEnd } = await searchParams;
    const repo = new EnergyRepo();


    const site = await repo.getSite(id);
    if (!site) {
        return <div>Site not found</div>;
    }

    // Determine start/end dates
    let start: Date;
    let end: Date;
    let isCustomRange = false;

    if (queryStart && queryEnd) {
        // Custom Range Mode
        const [sy, sm, sd] = queryStart.split('-').map(Number);
        const [ey, em, ed] = queryEnd.split('-').map(Number);

        // Construct dates (00:00:00 local time implicitly via Date constructor with args)
        // Note: Months depend on 0-index.
        start = new Date(sy, sm - 1, sd);

        // For end date: logic usually expects exclusive end for database queries?
        // Or inclusive for UI display?
        // In previous logic: "End date is start + 1 month".
        // repo.getUsageByTOU expects end date (exclusive upper bound).
        // If user picks "Dec 11" as end date, they usually mean "Include Dec 11".
        // So we should set end to Dec 12 00:00:00 OR Dec 11 23:59:59.
        // Let's add 1 day to the parsed end date.
        end = new Date(ey, em - 1, ed);
        end.setDate(end.getDate() + 1);

        isCustomRange = true;
    } else if (queryDate) {
        // Specific Billing Cycle Mode
        const [y, m, d] = queryDate.split('-').map(Number);
        start = new Date(y, m - 1, d);
        end = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
    } else {
        // Default to Current Billing Cycle
        const now = new Date();
        const billingDay = site.billing_start_day || 1;
        let startMonth = now.getMonth();
        const startYear = now.getFullYear();

        if (now.getDate() < billingDay) {
            startMonth--;
        }
        start = new Date(startYear, startMonth, billingDay);
        end = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
    }

    const usage = await repo.getUsageByTOU(id, start, end);

    // Format dates for display
    const fmtDate = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    // Recalculate end display date (inclusive) for UI label
    // If end is Dec 12 00:00, we want to display Dec 11.
    const displayEnd = new Date(end);
    displayEnd.setDate(displayEnd.getDate() - 1);

    // Previous and Next month links (only relevant for non-custom)
    const prevDate = new Date(start.getFullYear(), start.getMonth() - 1, start.getDate());
    const nextDate = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());


    // Check if next month would be in the future
    const currentDate = new Date();
    // For custom range, "Current Period" check is less relevant for "Next" button logic,
    // but useful for avoiding future dates generally?
    const isCurrentPeriod = !isCustomRange && (currentDate >= start && currentDate < end);

    const getDisplayLabel = (d: Date, includeYear: boolean) => {
        const mNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const month = mNames[d.getMonth()];
        const day = d.getDate();
        if (includeYear) return `${month} ${day}, ${d.getFullYear()}`;
        return `${month} ${day}`;
    };

    const dateRangeLabel = `${getDisplayLabel(start, false)} - ${getDisplayLabel(displayEnd, true)}`;

    // Usage Page is always viewing "full bill", so current val matches start
    const currentMonthVal = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    const fullBillDateStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(site.billing_start_day || 1).padStart(2, '0')}`;

    return (
        <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="w-full max-w-6xl">
                <Breadcrumbs items={[
                    { label: 'Dashboard', href: '/' },
                    { label: 'Site Details', href: `/site/${id}` },
                    { label: 'Estimated Bill' }
                ]} />

                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 sm:mb-8">
                    <h1 className="text-3xl font-bold">Estimated Monthly Bill</h1>
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
                </div>

                <DataSyncer siteId={id} start={start} end={end} viewDate={start} />

                <BillSummary usage={usage} alwaysExpanded={true} />
            </div>
        </div>
    );
}
