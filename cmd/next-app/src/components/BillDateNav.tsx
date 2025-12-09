'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface BillDateNavProps {
    siteId: string;
    billingDay: number;
    prevDateStr: string;
    nextDateStr: string;
    isCurrentPeriod: boolean;
    dateRangeLabel: string;
    currentMonthVal: string;
    fullBillDateStr: string;
}

export function BillDateNav({
    siteId,
    // startDate, // REMOVED
    // endDate,   // REMOVED
    billingDay,
    prevDateStr,
    nextDateStr,
    isCurrentPeriod,
    dateRangeLabel,
    currentMonthVal,
    fullBillDateStr
}: BillDateNavProps) {
    const router = useRouter();

    const handleMonthChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value; // YYYY-MM
        if (value) {
            // Construct date using the billing day
            const [year, month] = value.split('-');
            // Create target date: YYYY-MM-{billingDay}
            const targetDate = `${year}-${month}-${String(billingDay).padStart(2, '0')}`;
            router.push(`/site/${siteId}/usage?date=${targetDate}`);
        }
    };

    // Calculate current month value for the input (YYYY-MM based on start date)
    // const currentMonthVal = ... (Passed in prop now)

    // Max month should be the current calendar month to prevent picking far future/invalid ranges if desired, 
    // or just let the generic logic handle it. Let's restrict to current month to be safe.
    const now = new Date();
    // const maxMonth = ... (Unused)

    return (
        <div className="flex items-center gap-2">
            {/* Centered Date Navigation Pill */}
            <div className="flex items-center gap-1 bg-white dark:bg-slate-900 rounded-lg p-1 shadow-sm border border-slate-200 dark:border-slate-800 shrink-0">
                <Link
                    href={`/site/${siteId}/usage?date=${prevDateStr}`}
                    className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors flex-none"
                    title="Previous Month"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m15 18-6-6 6-6" />
                    </svg>
                </Link>

                <div className="relative group text-center min-w-[150px]">
                    <div className="font-semibold text-sm hover:underline decoration-blue-500 decoration-2 underline-offset-4 cursor-pointer rounded px-2 py-1 transition-colors w-full h-full flex items-center justify-center">
                        {dateRangeLabel}
                    </div>
                    {/* Month Picker Overlay (Select for better Safari compatibility) */}
                    <select
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 appearance-none"
                        onChange={handleMonthChange}
                        value={currentMonthVal}
                    >
                        {Array.from({ length: 24 }).map((_, i) => {
                            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                            const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                            return (
                                <option key={val} value={val}>
                                    {d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                                </option>
                            );
                        })}
                    </select>
                </div>

                {isCurrentPeriod ? (
                    <button
                        disabled
                        className="p-1.5 text-slate-300 dark:text-slate-700 cursor-not-allowed rounded-md flex-none"
                        title="Next Month (Future)"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m9 18 6-6-6-6" />
                        </svg>
                    </button>
                ) : (
                    <Link
                        href={`/site/${siteId}/usage?date=${nextDateStr}`}
                        className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors flex-none"
                        title="Next Month"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m9 18 6-6-6-6" />
                        </svg>
                    </Link>
                )}
            </div>

            {/* Separator */}
            <div className="w-px h-8 bg-slate-200 dark:bg-slate-800 mx-1 shrink-0"></div>

            {/* Action Buttons */}
            <div className='shrink-0 flex items-center'>
                <Link
                    href={`/site/${siteId}/usage?date=${fullBillDateStr}`}
                    className="p-2 text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-full transition-colors"
                    title="View Full Bill"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
                        <path d="M16 8h-6" />
                        <path d="M16 12h-6" />
                        <path d="M10 16h-6" />
                    </svg>
                </Link>
                <Link
                    href={`/site/${siteId}/tariffs`}
                    className="p-2 text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-full transition-colors"
                    title="View Tariffs"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l5 5a2 2 0 0 0 2.828 0l7.172-7.172a2 2 0 0 0 0-2.828l-5-5Z" />
                        <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
                    </svg>
                </Link>
            </div>
        </div>
    );
}
