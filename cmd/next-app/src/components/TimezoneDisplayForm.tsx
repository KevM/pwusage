'use client';

import { useState } from 'react';
import { updateTimezoneDisplayMode } from '@/app/site/[id]/settings/actions';

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
            <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Timezone Display Mode
                </label>
                <div className="flex gap-4">
                    <label className="inline-flex items-center">
                        <input
                            type="radio"
                            name="displayMode"
                            value="SITE"
                            checked={currentMode === 'SITE'}
                            onChange={() => handleSubmit('SITE')}
                            disabled={isPending}
                            className="form-radio text-blue-600 focus:ring-blue-500 h-4 w-4"
                        />
                        <span className="ml-2 text-gray-700 dark:text-gray-300">Site Timezone</span>
                    </label>
                    <label className="inline-flex items-center">
                        <input
                            type="radio"
                            name="displayMode"
                            value="BROWSER"
                            checked={currentMode === 'BROWSER'}
                            onChange={() => handleSubmit('BROWSER')}
                            disabled={isPending}
                            className="form-radio text-blue-600 focus:ring-blue-500 h-4 w-4"
                        />
                        <span className="ml-2 text-gray-700 dark:text-gray-300">My Local Timezone (Browser)</span>
                    </label>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                    Choose whether to display charts and data in the site&apos;s physical timezone or your current local timezone.
                </p>
            </div>
        </form>
    );
}
