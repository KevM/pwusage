'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatTouName } from '../lib/format-utils';

export interface ProductWithLiveData {
    id: string;
    site_name: string;
    energy_site_id: string;
    percentage_charged: number;
    currentTariff: string;
    liveBatteryPower: number;
    liveSolarPower: number;
    liveLoadPower: number;
    liveGridPower: number;
    type?: 'energy' | 'vehicle';
    meta?: unknown;
}

interface VehicleMeta {
    state?: string;
    vehicle_id?: number;
    option_codes?: string;
}

export function DashboardCards({ initialProducts }: { initialProducts: ProductWithLiveData[] }) {
    const [products, setProducts] = useState(initialProducts);
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

    useEffect(() => {
        // Initial update
        setTimeout(() => setLastUpdate(new Date()), 0);

        async function fetchLiveForProduct(p: ProductWithLiveData) {
            if (p.type === 'vehicle') return;

            try {
                const res = await fetch(`/api/site-live-data?siteId=${p.energy_site_id}`);
                if (res.ok) {
                    const data = await res.json();

                    setProducts(prev => prev.map(prod => {
                        if (prod.id === p.id) {
                            return {
                                ...prod,
                                liveSolarPower: data.solarPower,
                                liveBatteryPower: data.batteryPower,
                                liveGridPower: data.gridPower,
                                liveLoadPower: data.loadPower,
                                percentage_charged: data.percentageCharged,
                                currentTariff: prod.currentTariff === 'Loading...' ? (data.tariffName || 'Standard') : prod.currentTariff
                            };
                        }
                        return prod;
                    }));
                    setLastUpdate(new Date());
                }
            } catch (e) {
                console.error(`Failed to load live data for ${p.site_name}`, e);
            }
        }

        // Trigger fetch for all energy sites
        initialProducts.forEach(p => {
            if (p.type !== 'vehicle') {
                fetchLiveForProduct(p);
            }
        });

        // Poll every 60s
        const interval = setInterval(() => {
            products.forEach(p => {
                if (p.type !== 'vehicle') fetchLiveForProduct(p);
            });
        }, 60000);

        return () => clearInterval(interval);
    }, [initialProducts, products]); // Added dependency products

    return (
        <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {products.map((product) => {
                    if (product.type === 'vehicle') {
                        const meta = product.meta as VehicleMeta | undefined;
                        return (
                            <div key={product.id} className="border p-4 rounded shadow hover:shadow-lg transition bg-slate-50 dark:bg-slate-800">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-blue-600 dark:text-blue-400">
                                            <path fillRule="evenodd" clipRule="evenodd" d="M8.23607 5C7.09975 5 6.06096 5.64201 5.55279 6.65836L4.65836 8.44721C4.48897 8.786 4.1427 9 3.76393 9H3C1.34315 9 0 10.3431 0 12V14C0 15.3121 0.842366 16.4275 2.01581 16.8348C2.18436 18.6108 3.67994 20 5.5 20C7.26324 20 8.72194 18.6961 8.96456 17H15.0354C15.2781 18.6961 16.7368 20 18.5 20C20.3201 20 21.8156 18.6108 21.9842 16.8348C23.1576 16.4275 24 15.3121 24 14V12.6943C24 11.2277 22.9398 9.97617 21.4932 9.73507L17.6091 9.08772L15.9355 6.41C15.3873 5.53286 14.4259 5 13.3915 5H8.23607ZM4 16.4361V16.5639C4.03348 17.3634 4.69224 18.0013 5.5 18.0013C6.30776 18.0013 6.96652 17.3634 7 16.5639V16.4361C6.96652 15.6366 6.30776 14.9987 5.5 14.9987C4.69224 14.9987 4.03348 15.6366 4 16.4361ZM5.5 13C6.8962 13 8.10145 13.8175 8.66318 15H15.3368C15.8985 13.8175 17.1038 13 18.5 13C19.8245 13 20.9771 13.7357 21.5716 14.8207C21.8306 14.64 22 14.3398 22 14V12.6943C22 12.2054 21.6466 11.7882 21.1644 11.7079L16.9172 11H12C10.8954 11 10 10.1046 10 9V7H8.23607C7.8573 7 7.51103 7.214 7.34164 7.55279L6.44721 9.34164C5.93904 10.358 4.90025 11 3.76393 11H3C2.44772 11 2 11.4477 2 12V14C2 14.3398 2.16945 14.64 2.42845 14.8207C3.02292 13.7357 4.17555 13 5.5 13ZM12 7V8C12 8.55229 12.4477 9 13 9H15.1958L14.2395 7.47C14.0568 7.17762 13.7363 7 13.3915 7H12ZM17 16.4361V16.5639C17.0335 17.3634 17.6922 18.0013 18.5 18.0013C19.3078 18.0013 19.9665 17.3634 20 16.5639V16.4361C19.9665 15.6366 19.3078 14.9987 18.5 14.9987C17.6922 14.9987 17.0335 15.6366 17 16.4361Z" />
                                        </svg>
                                        <h2 className="text-xl font-semibold">{product.site_name}</h2>
                                    </div>
                                    <span className={`text-xs font-mono px-2 py-1 rounded ${meta?.state === 'online' ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
                                        {meta?.state || 'Unknown'}
                                    </span>
                                </div>
                                <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                                    <div className="flex justify-between border-b pb-1">
                                        <span className="text-gray-500">VIN</span>
                                        <span className="font-mono">{product.currentTariff}</span>
                                    </div>
                                    <div className="flex justify-between border-b pb-1">
                                        <span className="text-gray-500">ID</span>
                                        <span className="font-mono">{meta?.vehicle_id}</span>
                                    </div>
                                    {meta?.option_codes && (
                                        <div className="text-xs text-gray-400 truncate" title={meta.option_codes}>
                                            Options: {meta.option_codes}
                                        </div>
                                    )}
                                </div>
                                <div className="mt-4 pt-4 border-t border-gray-100 flex justify-end">
                                    <span className="text-xs text-gray-400 italic">
                                        Integrated via Tesla Fleet API
                                    </span>
                                </div>
                            </div>
                        );
                    }

                    return (
                        <Link
                            key={product.id}
                            href={`/site/${product.energy_site_id}`}
                            className="block"
                        >
                            <div className="border p-4 rounded shadow hover:shadow-lg transition cursor-pointer bg-white dark:bg-slate-900">
                                <div className="flex items-center gap-2 mb-3">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-green-600 dark:text-green-400">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
                                    </svg>
                                    <h2 className="text-xl font-semibold">{product.site_name}</h2>
                                </div>

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
                            </div>
                        </Link>
                    )
                })}
            </div>

            <div className="mt-8 text-center">
                <p className="text-xs text-slate-400 dark:text-slate-600">
                    Last updated: {lastUpdate ? lastUpdate.toLocaleTimeString() : '...'}
                </p>
            </div>
        </>
    );
}
