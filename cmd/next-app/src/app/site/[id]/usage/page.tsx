import { EnergyRepo } from '@/lib/energy-repo';
import { SettingsRepo } from '@/lib/settings-repo';
import { BillSummary } from '@/components/BillSummary';
import { BillDateNav } from '@/components/BillDateNav';
import Link from 'next/link';

import { Breadcrumbs } from '@/components/Breadcrumbs';

export const dynamic = 'force-dynamic';

export default async function UsagePage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ date?: string }>;
}) {
    const { id } = await params;
    const { date: queryDate } = await searchParams;
    const repo = new EnergyRepo();
    const settingsRepo = new SettingsRepo();

    const site = repo.getSite(id);
    if (!site) {
        return <div>Site not found</div>;
    }

    // Determine start date
    let start: Date;
    if (queryDate) {
        // Parse YYYY-MM-DD
        const [y, m, d] = queryDate.split('-').map(Number);
        start = new Date(y, m - 1, d);
    } else {
        // Default to current billing cycle
        const now = new Date();
        const billingDay = settingsRepo.getBillingStartDay();
        let startMonth = now.getMonth();
        let startYear = now.getFullYear();

        if (now.getDate() < billingDay) {
            startMonth--;
        }
        start = new Date(startYear, startMonth, billingDay);
    }

    // End date is start + 1 month
    const end = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());

    const usage = repo.getUsageByTOU(id, start, end);

    // Format dates for display
    const startStr = start.toLocaleDateString();
    const endStr = end.toLocaleDateString();

    // Previous and Next month links
    const prevDate = new Date(start.getFullYear(), start.getMonth() - 1, start.getDate());
    const nextDate = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());

    const fmtDate = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    // Check if next month would be in the future
    const currentDate = new Date();
    const isCurrentPeriod = currentDate >= start && currentDate < end;

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
                        startDate={start}
                        endDate={end}
                        billingDay={settingsRepo.getBillingStartDay()}
                        prevDateStr={fmtDate(prevDate)}
                        nextDateStr={fmtDate(nextDate)}
                        isCurrentPeriod={isCurrentPeriod}
                    />
                </div>

                <BillSummary usage={usage} alwaysExpanded={true} />
            </div>
        </div>
    );
}
