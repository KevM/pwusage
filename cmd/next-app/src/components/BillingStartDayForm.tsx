'use client';

import { useState, useTransition } from 'react';
import { updateBillingStartDay } from '@/app/site/[id]/settings/actions';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Form';

interface Props {
    siteId: string;
    initialDay: number;
}

export function BillingStartDayForm({ siteId, initialDay }: Props) {
    const [day, setDay] = useState(initialDay);
    const [isPending, startTransition] = useTransition();
    const [saved, setSaved] = useState(false);

    // Sync state if server data changes (e.g. after revalidation).
    // Uses the React-documented render-phase pattern instead of useEffect:
    // https://react.dev/reference/react/useState#storing-information-from-previous-renders
    const [syncedInitialDay, setSyncedInitialDay] = useState(initialDay);
    if (syncedInitialDay !== initialDay) {
        setSyncedInitialDay(initialDay);
        setDay(initialDay);
    }

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
                <Label htmlFor={`billingStartDay-${siteId}`} className="mb-2 block">
                    Billing Cycle Start Day
                </Label>
                <Input
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
                />
            </div>

            <div className="flex flex-col relative">
                <Button
                    type="submit"
                    disabled={!isDirty || isPending}
                    className="mb-0.5 w-[85px]"
                    variant="primary"
                >
                    {isPending ? 'Saving...' : 'Save'}
                </Button>
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
