'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import React, { useState } from 'react';

interface BillDateNavProps {
    siteId: string;
    billingDay: number;
    prevDateStr: string;
    nextDateStr: string;
    isCurrentPeriod: boolean;
    dateRangeLabel: string;
    currentMonthVal: string;
    fullBillDateStr: string;
    isCustomRange?: boolean;
    customStart?: string;
    customEnd?: string;
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
    fullBillDateStr,
    isCustomRange = false,
    customStart = '',
    customEnd = ''
}: BillDateNavProps) {
    const router = useRouter();
    const [showCustomPicker, setShowCustomPicker] = useState(false);
    const [startDate, setStartDate] = useState(customStart);
    const [endDate, setEndDate] = useState(customEnd);

    // Sync state with props if they change (e.g. navigation)
    React.useEffect(() => {
        if (isCustomRange) {
            setStartDate(customStart);
            setEndDate(customEnd);
        }
    }, [isCustomRange, customStart, customEnd]); // Lint might want React.useEffect vs useEffect

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

    const applyCustomRange = () => {
        if (startDate && endDate) {
            router.push(`/site/${siteId}/usage?start=${startDate}&end=${endDate}`);
            setShowCustomPicker(false);
        }
    };

    const clearCustomRange = () => {
        // Go to default view (no params)
        router.push(`/site/${siteId}/usage`);
        setShowCustomPicker(false);
    };

    // Calculate current month value for the input (YYYY-MM based on start date)
    // const currentMonthVal = ... (Passed in prop now)

    const now = new Date();

    return (
        <div className="flex items-center gap-2 relative">
            {/* Centered Date Navigation Pill */}
            <div className={`flex items-center gap-1 bg-white dark:bg-slate-900 rounded-lg p-1 shadow-sm border ${isCustomRange ? 'border-blue-500 ring-1 ring-blue-500' : 'border-slate-200 dark:border-slate-800'} shrink-0`}>
                {/* Hide Prev Arrow in Custom Mode? Or let it function as "Previous Month" relative to custom start? 
                    The props provide prevDateStr which is calculated based on start-1 month. 
                    If custom range is 34 days, "Previous Month" logic might be weird (start - 1 month).
                    Let's hide arrows in Custom Mode to imply "Fixed Range".
                 */}
                {!isCustomRange && (
                    <Link
                        href={`/site/${siteId}/usage?date=${prevDateStr}`}
                        className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors flex-none"
                        title="Previous Month"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m15 18-6-6 6-6" />
                        </svg>
                    </Link>
                )}

                <div className="relative group text-center min-w-[150px]">
                    <div
                        onClick={() => setShowCustomPicker(!showCustomPicker)}
                        className="font-semibold text-sm hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer rounded px-2 py-1 transition-colors w-full h-full flex items-center justify-center select-none"
                    >
                        {dateRangeLabel}
                        {isCustomRange && <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">Custom</span>}
                    </div>

                    {/* Month Picker Overlay (Standard Mode Only) */}
                    {!isCustomRange && !showCustomPicker && (
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
                    )}
                </div>

                {!isCustomRange && (
                    isCurrentPeriod ? (
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
                    )
                )}
            </div>

            {/* Custom Picker Popover */}
            {showCustomPicker && (
                <div className="absolute top-full left-0 mt-2 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl z-50 w-[300px]">
                    <h4 className="font-semibold mb-3 text-sm text-slate-900 dark:text-slate-100">Select Date Range</h4>
                    <div className="space-y-3">
                        <div>
                            <label className="block text-xs text-slate-500 mb-1">Start Date</label>
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                                className="w-full text-sm p-2 border rounded bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-slate-500 mb-1">End Date</label>
                            <input
                                type="date"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                                className="w-full text-sm p-2 border rounded bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                            />
                        </div>
                        <div className="flex gap-2 pt-2">
                            <button
                                onClick={applyCustomRange}
                                disabled={!startDate || !endDate}
                                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 rounded disabled:opacity-50"
                            >
                                Apply
                            </button>
                            {isCustomRange && (
                                <button
                                    onClick={clearCustomRange}
                                    className="flex-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-medium py-2 rounded"
                                >
                                    Reset
                                </button>
                            )}
                            {!isCustomRange && (
                                <button
                                    onClick={() => setShowCustomPicker(false)}
                                    className="flex-1 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-sm font-medium py-2 rounded"
                                >
                                    Cancel
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Overlay to close picker when clicking outside */}
            {showCustomPicker && (
                <div className="fixed inset-0 z-40 bg-transparent" onClick={() => setShowCustomPicker(false)} />
            )}

            {/* Separator */}
            <div className="w-px h-8 bg-slate-200 dark:bg-slate-800 mx-1 shrink-0"></div>

            {/* Action Buttons */}
            <div className='shrink-0 flex items-center'>
                <button
                    onClick={() => setShowCustomPicker(!showCustomPicker)}
                    className={`p-2 rounded-full transition-colors ${isCustomRange ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/30' : 'text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30'}`}
                    title="Custom Date Range"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                </button>

                <Link
                    href={`/site/${siteId}/usage?date=${fullBillDateStr}`}
                    className="p-2 text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-full transition-colors"
                    title="View Full Bill (Current Cycle)"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
                        <path d="M16 8h-6" />
                        <path d="M16 12h-6" />
                        <path d="M10 16h-6" />
                    </svg>
                </Link>

            </div>
        </div>
    );
}
