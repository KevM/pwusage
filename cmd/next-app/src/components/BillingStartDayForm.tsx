'use client';

import { useState, useTransition, useEffect } from 'react';
import { updateBillingStartDay } from '@/app/site/[id]/settings/actions';

interface Props {
    siteId: string;
    initialDay: number;
}

export function BillingStartDayForm({ siteId, initialDay }: Props) {
    const [day, setDay] = useState(initialDay);
    const [isPending, startTransition] = useTransition();
    const [saved, setSaved] = useState(false);

    // Sync state if server data changes (e.g. after revalidation)
    useEffect(() => {
        setDay(initialDay);
    }, [initialDay]);

    const isDirty = day !== initialDay;

    const handleSubmit = async (formData: FormData) => {
        setSaved(false);
        startTransition(async () => {
            try {
                await updateBillingStartDay(formData);
                setSaved(true);
                // Clear saved message after 3 seconds
                setTimeout(() => setSaved(false), 3000);
            } catch (error) {
                console.error('Failed to update billing day:', error);
                // Optionally handle error state
            }
        });
    };

    return (
        <form action={handleSubmit} className="flex gap-4 items-end">
            <input type="hidden" name="siteId" value={siteId} />
            <div className="flex-grow max-w-xs">
                <label htmlFor={`billingStartDay-${siteId}`} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Billing Cycle Start Day
                </label>
                <input
                    type="number"
                    id={`billingStartDay-${siteId}`}
                    name="billingStartDay"
                    value={day}
                    onChange={(e) => {
                        setSaved(false);
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val)) setDay(val);
                    }}
                    min="1"
                    max="31"
                    className="block w-full rounded-md border-gray-300 dark:border-slate-700 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border dark:bg-slate-800 dark:text-white"
                />
            </div>

            <div className="flex flex-col relative">
                <button
                    type="submit"
                    disabled={!isDirty || isPending}
                    className={`px-4 py-2 rounded transition-colors h-10 mb-0.5 ${isDirty && !isPending
                        ? 'bg-blue-600 text-white hover:bg-blue-700'
                        : 'bg-gray-300 dark:bg-slate-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                        }`}
                >
                    {isPending ? 'Saving...' : 'Save'}
                </button>
                {saved && (
                    <span className="text-green-600 dark:text-green-400 text-xs text-center absolute -bottom-6 w-full left-0">
                        Saved
                    </span>
                )}
            </div>
            {/* Relative positioning wrapper needed if we want absolute positioning of "Saved" label relative to button, 
                but simpler to just put it below properly. 
            */}
        </form>
    );
}
