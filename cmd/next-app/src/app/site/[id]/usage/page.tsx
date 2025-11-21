import { EnergyRepo } from '@/lib/energy-repo';
import { SettingsRepo } from '@/lib/settings-repo';
import { BillSummary } from '@/components/BillSummary';
import Link from 'next/link';

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
        <div className="flex min-h-screen flex-col items-center p-24">
            <div className="w-full max-w-6xl">
                <Link href={`/site/${id}`} className="text-blue-600 hover:underline mb-4 block">&larr; Back to Site Dashboard</Link>

                <div className="flex justify-between items-center mb-8">
                    <h1 className="text-3xl font-bold">Simulated Bill: {startStr} - {endStr}</h1>
                    <div className="space-x-4">
                        <Link
                            href={`/site/${id}/usage?date=${fmtDate(prevDate)}`}
                            className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 dark:bg-slate-700 dark:hover:bg-slate-600"
                        >
                            &larr; Previous Month
                        </Link>
                        {isCurrentPeriod ? (
                            <span className="px-4 py-2 bg-gray-100 rounded text-gray-400 cursor-not-allowed dark:bg-slate-800">
                                Next Month &rarr;
                            </span>
                        ) : (
                            <Link
                                href={`/site/${id}/usage?date=${fmtDate(nextDate)}`}
                                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 dark:bg-slate-700 dark:hover:bg-slate-600"
                            >
                                Next Month &rarr;
                            </Link>
                        )}
                    </div>
                </div>

                <BillSummary usage={usage} />
            </div>
        </div>
    );
}
