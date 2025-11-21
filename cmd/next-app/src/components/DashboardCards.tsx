'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatTouName } from '../lib/format-utils';

interface ProductWithLiveData {
    id: string;
    site_name: string;
    energy_site_id: number;
    percentage_charged: number;
    currentTariff: string;
    liveBatteryPower: number;
    liveSolarPower: number;
    liveLoadPower: number;
    liveGridPower: number;
}

export function DashboardCards({ initialProducts }: { initialProducts: ProductWithLiveData[] }) {
    const [products, setProducts] = useState(initialProducts);
    const [lastUpdate, setLastUpdate] = useState(new Date());

    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                // Fetch fresh data from API route
                const response = await fetch('/api/dashboard-data');
                if (response.ok) {
                    const data = await response.json();
                    setProducts(data.products);
                    setLastUpdate(new Date());
                }
            } catch (error) {
                console.error('Failed to refresh dashboard:', error);
            }
        }, 60000); // 60 seconds

        return () => clearInterval(interval);
    }, []);

    return (
        <>
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-4xl font-bold">Dashboard</h1>
                <div className="flex gap-4 items-center">
                    <span className="text-xs text-gray-400">
                        Updated: {lastUpdate.toLocaleTimeString()}
                    </span>
                    <Link href="/settings" className="text-blue-600 hover:underline">Settings</Link>
                    <form action="/logout" method="POST">
                        <button type="submit" className="text-red-600 hover:underline">Logout</button>
                    </form>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {products.map((product) => (
                    <Link
                        key={product.id}
                        href={`/site/${product.energy_site_id}`}
                        className="block"
                    >
                        <div className="border p-4 rounded shadow hover:shadow-lg transition cursor-pointer">
                            <h2 className="text-xl font-semibold mb-3">{product.site_name}</h2>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                <div>
                                    <p className="text-amber-700">Solar: {(product.liveSolarPower / 1000).toFixed(1)} kW</p>
                                    <p className="text-purple-700">Battery: {(product.liveBatteryPower / 1000).toFixed(1)} kW</p>
                                    <p className="text-gray-600">Charge: {Math.round(product.percentage_charged)}%</p>
                                </div>
                                <div>
                                    <p className="text-orange-700">Grid: {(product.liveGridPower / 1000).toFixed(1)} kW</p>
                                    <p className="text-blue-700">Load: {(product.liveLoadPower / 1000).toFixed(1)} kW</p>
                                </div>
                            </div>
                            <p className="text-sm text-gray-500 mt-2">Tariff: {formatTouName(product.currentTariff)}</p>
                            <div className="mt-4">
                                <span className="text-blue-600 hover:underline">
                                    View Details
                                </span>
                            </div>
                        </div>
                    </Link>
                ))}
            </div>
        </>
    );
}
