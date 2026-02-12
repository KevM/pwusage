'use client';

import { useEffect, useState } from 'react';


interface LiveStats {
    solarPower: number;
    loadPower: number;
    batteryPower: number;
    gridPower: number;
    percentageCharged: number;
    batteryState?: string; // 'Charging', 'Discharging', 'Idle'
}

export function HeaderLiveStats({ siteId }: { siteId: string }) {
    const [stats, setStats] = useState<LiveStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        async function fetchStats() {
            try {
                const response = await fetch(`/api/site-live-data?siteId=${siteId}`);

                if (!isMounted) return;

                if (!response.ok) {
                    if (response.status === 401) {
                        console.warn('[HeaderLiveStats] Unauthorized. Redirecting to login...');
                        window.location.href = '/login';
                        return;
                    }
                    console.error('[HeaderLiveStats] Fetch failed:', response.status, response.statusText);
                    setLoading(false);
                    return;
                }

                const data = await response.json();
                if (!isMounted) return;

                setStats(data);
                setLoading(false);
            } catch (error) {
                if (isMounted) {
                    console.error('Failed to refresh header stats:', error);
                    setLoading(false);
                }
            }
        }

        // Initial fetch
        fetchStats();

        // Poll every 2 minutes
        const interval = setInterval(fetchStats, 120000);

        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, [siteId]);

    if (loading) {
        return (
            <div className="flex items-center gap-4 text-xs text-gray-400">
                <span>Loading...</span>
            </div>
        );
    }

    if (!stats) {
        return (
            <div className="flex items-center gap-4 text-xs text-red-400">
                <span>Stats Unavailable</span>
            </div>
        );
    }

    const { solarPower, loadPower, batteryPower, gridPower, percentageCharged } = stats;

    // Helper to format power (W to kW)
    const fmtKw = (w: number) => (Math.abs(w) / 1000).toFixed(1);

    return (
        <div className="flex items-center justify-between w-full md:w-auto md:justify-start md:gap-6 text-sm">
            {/* Solar */}
            <div className="flex flex-col items-center" title="Solar Production">
                <span className="text-xs text-gray-500 uppercase font-medium">Solar</span>
                <span className="font-semibold text-amber-600">{fmtKw(solarPower)} kW</span>
            </div>

            {/* Load */}
            <div className="flex flex-col items-center" title="Home Usage">
                <span className="text-xs text-gray-500 uppercase font-medium">Load</span>
                <span className="font-semibold text-blue-600">{fmtKw(loadPower)} kW</span>
            </div>

            {/* Battery */}
            <div className="flex flex-col items-center" title={`Battery (${Math.round(percentageCharged)}%)`}>
                <span className="text-xs text-gray-500 uppercase font-medium">Battery</span>
                <div className="flex items-center gap-1">
                    <span className={`font-semibold ${batteryPower < -100 ? 'text-green-600' : batteryPower > 100 ? 'text-red-500' : 'text-purple-600'}`}>
                        {Math.round(percentageCharged)}%
                    </span>
                    {batteryPower < -100 && (
                        <svg className="w-3 h-3 text-green-600 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    )}
                </div>
            </div>

            {/* Grid */}
            <div className="flex flex-col items-center" title="Grid Usage">
                <span className="text-xs text-gray-500 uppercase font-medium">Grid</span>
                {/* Positive grid = Importing (taking from grid), Negative grid = Exporting (sending to grid) */}
                <span className={`font-semibold ${gridPower > 100 ? 'text-orange-600' : gridPower < -100 ? 'text-green-600' : 'text-gray-600'}`}>
                    {fmtKw(Math.abs(gridPower))} kW
                </span>
            </div>
        </div>
    );
}
