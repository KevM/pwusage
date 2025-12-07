'use client';

import { useEffect, useState } from 'react';
import { formatTouName } from '../lib/format-utils';

interface LiveStats {
    solarPower: number;
    loadPower: number;
    batteryPower: number;
    gridPower: number;
    percentageCharged: number;
    currentTariff: string;
}

export function SiteLiveStats({ siteId, initialStats }: { siteId: string; initialStats: LiveStats }) {
    const [stats, setStats] = useState(initialStats);
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

    useEffect(() => {
        setLastUpdate(new Date()); // Set initial time on client mount

        const interval = setInterval(async () => {
            try {
                const response = await fetch(`/api/site-live-data?siteId=${siteId}`);
                if (response.ok) {
                    const data = await response.json();
                    setStats(data);
                    setLastUpdate(new Date());
                }
            } catch (error) {
                console.error('Failed to refresh site stats:', error);
            }
        }, 60000); // 60 seconds

        return () => clearInterval(interval);
    }, [siteId]);

    return (
        <div className="mb-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-2">
                <div className="bg-amber-50 border-l-4 border-amber-500 p-3 rounded">
                    <p className="text-sm text-gray-600">Solar</p>
                    <p className="text-xl font-semibold text-amber-700">{(stats.solarPower / 1000).toFixed(1)} kW</p>
                </div>
                <div className="bg-blue-50 border-l-4 border-blue-500 p-3 rounded">
                    <p className="text-sm text-gray-600">Load</p>
                    <p className="text-xl font-semibold text-blue-700">{(stats.loadPower / 1000).toFixed(1)} kW</p>
                </div>
                <div className="bg-purple-50 border-l-4 border-purple-500 p-3 rounded">
                    <p className="text-sm text-gray-600">Battery</p>
                    <p className="text-xl font-semibold text-purple-700">{(stats.batteryPower / 1000).toFixed(1)} kW</p>
                </div>
                <div className="bg-orange-50 border-l-4 border-orange-500 p-3 rounded">
                    <p className="text-sm text-gray-600">Grid</p>
                    <p className="text-xl font-semibold text-orange-700">{(stats.gridPower / 1000).toFixed(1)} kW</p>
                </div>
            </div>

            <div className="flex flex-wrap justify-between items-center gap-4 mt-4 px-1 text-sm">
                <div className="flex items-center gap-4 shrink-0">
                    <div className="flex items-center gap-2">
                        {/* Battery Icon */}
                        <div className="relative" title={`Battery: ${Math.round(stats.percentageCharged)}%`}>
                            {/* Battery Body */}
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`
                                ${stats.percentageCharged <= 20 ? 'text-red-500' : stats.percentageCharged > 20 && stats.percentageCharged <= 50 ? 'text-amber-500' : 'text-green-500'}
                            `}>
                                <rect x="2" y="7" width="20" height="10" rx="2" ry="2" />
                                <line x1="22" y1="11" x2="22" y2="13" />
                                <line x1="6" y1="12" x2={6 + (12 * (Math.min(stats.percentageCharged, 100) / 100))} y2="12" strokeWidth="4" />
                            </svg>
                            {/* Charging Bolt Overlay */}
                            {stats.batteryPower < -100 && (
                                <div className="absolute -top-1 -right-1 bg-white dark:bg-slate-900 rounded-full p-0.5 shadow-sm">
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="#fbbf24" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                                    </svg>
                                </div>
                            )}
                        </div>
                        <span className="font-semibold">{Math.round(stats.percentageCharged)}%</span>
                    </div>

                    <div className="w-px h-4 bg-slate-300 dark:bg-slate-700"></div>

                    <div className="flex items-center gap-2">
                        <span className="text-gray-500 dark:text-gray-400">Tariff:</span>
                        <span className="font-medium text-slate-700 dark:text-slate-300">{formatTouName(stats.currentTariff)}</span>
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-gray-400">Updated: {lastUpdate ? lastUpdate.toLocaleTimeString() : 'Syncing...'}</span>
                </div>
            </div>
        </div >
    );
}
