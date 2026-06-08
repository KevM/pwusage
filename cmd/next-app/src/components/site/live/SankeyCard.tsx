'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';

interface SankeyCardProps {
    snapshotSvg: string;
    cumulativeSvg: string;
}

export function SankeyCard({ snapshotSvg, cumulativeSvg }: SankeyCardProps) {
    const [basis, setBasis] = useState<'snapshot' | 'cumulative'>('snapshot');
    const svg = basis === 'snapshot' ? snapshotSvg : cumulativeSvg;

    return (
        <SectionCard
            title="Energy Value Flow"
            description="Where your power comes from and where surplus goes, colored by arbitrage value."
        >
            <div className="mb-3 inline-flex rounded-md border border-gray-300 overflow-hidden text-sm">
                <button
                    type="button"
                    onClick={() => setBasis('snapshot')}
                    className={`px-3 py-1 cursor-pointer transition-colors duration-150 ${basis === 'snapshot' ? 'bg-black text-white font-medium' : 'bg-white text-black hover:bg-gray-100'}`}
                >
                    Now
                </button>
                <button
                    type="button"
                    onClick={() => setBasis('cumulative')}
                    className={`px-3 py-1 cursor-pointer transition-colors duration-150 ${basis === 'cumulative' ? 'bg-black text-white font-medium' : 'bg-white text-black hover:bg-gray-100'}`}
                >
                    Today
                </button>
            </div>
            <div className="w-full overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-800 p-4 text-foreground" dangerouslySetInnerHTML={{ __html: svg }} />
        </SectionCard>
    );
}
