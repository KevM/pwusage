'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import React, { useState } from 'react';
import { DateNavigator, DateNavigatorButton, DateNavigatorContent, DateNavigatorLabel } from './ui/DateNavigator';
import { Button } from './ui/Button';
import { Input, Label } from './ui/Form';

interface BillDateNavProps {
    earliestDate?: string;
    earliestMonth?: string;
    canGoPrevious?: boolean;
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
    earliestDate,
    earliestMonth,
    canGoPrevious = true,
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

    // Sync state with props if they change (e.g. navigation).
    // Uses the React-documented render-phase pattern instead of useEffect:
    // https://react.dev/reference/react/useState#storing-information-from-previous-renders
    const [syncedProps, setSyncedProps] = useState({ start: customStart, end: customEnd, range: isCustomRange });
    if (
        syncedProps.start !== customStart ||
        syncedProps.end !== customEnd ||
        syncedProps.range !== isCustomRange
    ) {
        setSyncedProps({ start: customStart, end: customEnd, range: isCustomRange });
        if (isCustomRange) {
            setStartDate(customStart);
            setEndDate(customEnd);
        }
    }

    const handleMonthChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value; // YYYY-MM
        if (value && (!earliestMonth || value >= earliestMonth)) {
            // Construct date using the billing day
            const [year, month] = value.split('-');
            // Create target date: YYYY-MM-{billingDay}
            const targetDate = `${year}-${month}-${String(billingDay).padStart(2, '0')}`;
            router.push(`/site/${siteId}/usage?date=${targetDate}`);
        }
    };

    const applyCustomRange = () => {
        if (startDate && endDate && startDate <= endDate && (!earliestDate || startDate >= earliestDate)) {
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
            <DateNavigator isCustom={isCustomRange}>
                {!isCustomRange && (
                    <DateNavigatorButton href={`/site/${siteId}/usage?date=${prevDateStr}`} direction="prev" disabled={!canGoPrevious} />
                )}

                <DateNavigatorContent>
                    <DateNavigatorLabel
                        onClick={() => setShowCustomPicker(!showCustomPicker)}
                        isCustom={isCustomRange}
                    >
                        {dateRangeLabel}
                    </DateNavigatorLabel>

                    {/* Month Picker Overlay (Standard Mode Only) */}
                    {!isCustomRange && !showCustomPicker && (
                        <select
                            aria-label="Billing period"
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 appearance-none"
                            onChange={handleMonthChange}
                            value={currentMonthVal}
                        >
                            {Array.from({ length: 24 }).map((_, i) => {
                                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                                const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                                if (earliestMonth && val < earliestMonth) return null;
                                return (
                                    <option key={val} value={val}>
                                        {d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                                    </option>
                                );
                            })}
                        </select>
                    )}
                </DateNavigatorContent>

                {!isCustomRange && (
                    <DateNavigatorButton
                        href={isCurrentPeriod ? undefined : `/site/${siteId}/usage?date=${nextDateStr}`}
                        direction="next"
                        disabled={isCurrentPeriod}
                    />
                )}
            </DateNavigator>

            {/* Custom Picker Popover */}
            {showCustomPicker && (
                <div className="absolute top-full left-0 mt-2 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl z-50 w-[300px]">
                    <h4 className="font-semibold mb-3 text-sm text-slate-900 dark:text-slate-100">Select Date Range</h4>
                    <div className="space-y-3">
                        <div>
                            <Label className="block text-xs text-slate-500 mb-1">Start Date</Label>
                            <Input
                                type="date"
                                min={earliestDate}
                                value={startDate || ''}
                                onChange={(e) => setStartDate(e.target.value)}
                                className="w-full h-9 text-sm bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                            />
                        </div>
                        <div>
                            <Label className="block text-xs text-slate-500 mb-1">End Date</Label>
                            <Input
                                type="date"
                                min={earliestDate}
                                value={endDate || ''}
                                onChange={(e) => setEndDate(e.target.value)}
                                className="w-full h-9 text-sm bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                            />
                        </div>
                        <div className="flex gap-2 pt-2">
                            <Button
                                onClick={applyCustomRange}
                                disabled={!startDate || !endDate || startDate > endDate || (!!earliestDate && startDate < earliestDate)}
                                className="flex-1"
                            >
                                Apply
                            </Button>
                            {isCustomRange && (
                                <Button
                                    onClick={clearCustomRange}
                                    variant="secondary"
                                    className="flex-1"
                                >
                                    Reset
                                </Button>
                            )}
                            {!isCustomRange && (
                                <Button
                                    onClick={() => setShowCustomPicker(false)}
                                    variant="outline"
                                    className="flex-1"
                                >
                                    Cancel
                                </Button>
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
                <Button
                    onClick={() => setShowCustomPicker(!showCustomPicker)}
                    appearance="glyph"
                    size="md"
                    className={isCustomRange ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : ''}
                    title="Custom Date Range"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                </Button>

                <Link
                    href={`/site/${siteId}/usage?date=${fullBillDateStr}`}
                    title="View Full Bill (Current Cycle)"
                    aria-label="View Full Bill (Current Cycle)"
                >
                    <Button appearance="glyph" size="md" renderAs="span">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
                            <path d="M16 8h-6" />
                            <path d="M16 12h-6" />
                            <path d="M10 16h-6" />
                        </svg>
                    </Button>
                </Link>

            </div>
        </div>
    );
}
