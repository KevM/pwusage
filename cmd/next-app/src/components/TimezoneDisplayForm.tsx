'use client';

import { useState } from 'react';
import { updateTimezoneDisplayMode } from '@/app/site/[id]/settings/actions';
import { Label, Radio } from '@/components/ui/Form';

interface TimezoneDisplayFormProps {
    siteId: string;
    initialMode: 'SITE' | 'BROWSER';
}

export function TimezoneDisplayForm({ siteId, initialMode }: TimezoneDisplayFormProps) {
    const [currentMode, setCurrentMode] = useState(initialMode);
    const [isPending, setIsPending] = useState(false);

    const handleSubmit = async (mode: 'SITE' | 'BROWSER') => {
        setIsPending(true);
        const formData = new FormData();
        formData.append('siteId', siteId);
        formData.append('displayMode', mode);

        try {
            await updateTimezoneDisplayMode(formData);
            setCurrentMode(mode);
        } catch (error) {
            console.error('Failed to update timezone display mode:', error);
            alert('Failed to update settings. Please try again.');
        } finally {
            setIsPending(false);
        }
    };

    return (
        <form className="space-y-4">
            <div className="flex flex-col gap-3">
                <Label className="block">
                    Timezone Display Mode
                </Label>
                <div className="flex gap-6">
                    <Label className="inline-flex items-center cursor-pointer font-normal">
                        <Radio
                            name="displayMode"
                            value="SITE"
                            checked={currentMode === 'SITE'}
                            onChange={() => handleSubmit('SITE')}
                            disabled={isPending}
                        />
                        <span className="ml-2">Site Timezone</span>
                    </Label>
                    <Label className="inline-flex items-center cursor-pointer font-normal">
                        <Radio
                            name="displayMode"
                            value="BROWSER"
                            checked={currentMode === 'BROWSER'}
                            onChange={() => handleSubmit('BROWSER')}
                            disabled={isPending}
                        />
                        <span className="ml-2">My Local Timezone (Browser)</span>
                    </Label>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                    Choose whether to display charts and data in the site&apos;s physical timezone or your current local timezone.
                </p>
            </div>
        </form>
    );
}
