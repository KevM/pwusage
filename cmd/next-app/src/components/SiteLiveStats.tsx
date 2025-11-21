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
    const [lastUpdate, setLastUpdate] = useState(new Date());

    useEffect(() => {
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
            <div className="flex justify-between items-center text-sm">
                <div>
                    <span className="text-gray-600">Charge: </span>
                    <span className="font-semibold">{Math.round(stats.percentageCharged)}%</span>
                    <span className="text-gray-600 ml-4">Tariff: </span>
                    <span className="font-semibold">{formatTouName(stats.currentTariff)}</span>
                </div>
                <span className="text-xs text-gray-400">Updated: {lastUpdate.toLocaleTimeString()}</span>
            </div>
        </div>
    );
}
