'use client';

import { HistoryView } from '@/components/site/HistoryView';
import LoadAnalysisClientPage from '@/components/LoadAnalysisClientPage';

export interface HistoryTabProps {
    siteId: string;
    siteName: string;
    defaultDate: string;
    siteTimezone: string;
    displayMode: 'SITE' | 'BROWSER';
}

/** The History tab's content. Loaded only when History is the selected tab (see `SiteTabPanels`). */
export default function HistoryTab(props: HistoryTabProps) {
    return (
        <HistoryView
            chartNavSlot={null}
            analysisSlot={<LoadAnalysisClientPage {...props} />}
        />
    );
}
