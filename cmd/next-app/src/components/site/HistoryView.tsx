'use client';

import { ReactNode } from 'react';

interface HistoryViewProps {
    chartNavSlot: ReactNode;
    analysisSlot: ReactNode; // Using slots to avoid deep prop drilling/import cycles if possible
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function HistoryView({ chartNavSlot, analysisSlot }: HistoryViewProps) {
    return (
        <div className="space-y-8">
            {analysisSlot}
        </div>
    );
}
