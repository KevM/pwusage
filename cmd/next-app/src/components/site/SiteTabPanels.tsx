'use client';

import dynamic from 'next/dynamic';
import { Spinner } from '@/components/ui/Spinner';

function PanelLoading() {
    return (
        <div className="flex justify-center py-12" role="status" aria-label="Loading">
            <Spinner />
        </div>
    );
}

/**
 * History and Settings are split into their own chunks so the default
 * Estimated Bill visit does not download the History chart or the Settings
 * forms. The server renders only the selected tab, so each chunk loads only
 * when its tab is shown.
 */
export const LazyHistoryTab = dynamic(() => import('./HistoryTab'), { loading: PanelLoading });

export const LazySettingsView = dynamic(
    () => import('./SettingsView').then(module => module.SettingsView),
    { loading: PanelLoading }
);
