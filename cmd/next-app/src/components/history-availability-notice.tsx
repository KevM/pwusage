import type { HistoryAvailability } from '@/lib/history-retention';

export function HistoryAvailabilityNotice({ availability, timezone }: { availability: HistoryAvailability; timezone: string }) {
    if (availability.status === 'available') return null;
    const date = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(availability.availableFrom));
    return (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            {availability.status === 'unavailable'
                ? `History unavailable. Retained history starts on ${date}. Choose a more recent date.`
                : `Partial history. Only data from ${date} onward is included; these totals do not represent the full selected period.`}
        </p>
    );
}
