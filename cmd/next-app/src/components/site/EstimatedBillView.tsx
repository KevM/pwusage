'use client';

import { ReactNode } from 'react';
import { H2 } from '@/components/ui/Typography';

interface EstimatedBillViewProps {
    billSummarySlot: ReactNode;
    billNavSlot: ReactNode;
}

export function EstimatedBillView({ billSummarySlot, billNavSlot }: EstimatedBillViewProps) {
    return (
        <div className="space-y-6 max-w-6xl mx-auto">
            <div className="flex flex-wrap justify-between items-center mb-4 gap-4">
                <H2>Estimated Monthly Bill</H2>
                {billNavSlot}
            </div>
            {billSummarySlot}
        </div>
    );
}
