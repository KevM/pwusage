'use client';

import { ReactNode } from 'react';

interface EstimatedBillViewProps {
    billSummarySlot: ReactNode;
    billNavSlot: ReactNode;
}

export function EstimatedBillView({ billSummarySlot, billNavSlot }: EstimatedBillViewProps) {
    return (
        <div className="space-y-6 max-w-6xl mx-auto">
            <div className="flex flex-wrap justify-between items-center mb-4 gap-4">
                <h2 className="text-2xl font-bold">Estimated Monthly Bill</h2>
                {billNavSlot}
            </div>
            {billSummarySlot}
        </div>
    );
}
