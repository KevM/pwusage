'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatTouName } from '../lib/format-utils';
import { fetchSiteLiveData, isValidSiteId } from '@/lib/site-live-data-client';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusPill } from '@/components/ui/StatusPill';

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

function VehicleIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-6 w-6 text-blue-600 dark:text-blue-400" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5h16.5m-14.25 0-.75 3h3l.75-3m9.75 0 .75 3h-3l-.75-3M5.25 13.5l1.08-4.318A2.25 2.25 0 0 1 8.514 7.5h6.972a2.25 2.25 0 0 1 2.184 1.682l1.08 4.318M6.75 18.75h10.5" />
        </svg>
    );
}

function EnergySiteIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-6 w-6 text-green-600 dark:text-green-400" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
        </svg>
    );
}

export function DashboardCards({ initialProducts }: { initialProducts: ProductWithLiveData[] }) {
    const [products, setProducts] = useState(initialProducts);
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
    const productsRef = useRef(products);

    useEffect(() => {
        productsRef.current = products;
    }, [products]);

    useEffect(() => {
        let isMounted = true;
        const controller = new AbortController();
        const initialTimer = setTimeout(() => setLastUpdate(new Date()), 0);

        productsRef.current = initialProducts;

        // Initial update

        async function fetchLiveForProduct(p: ProductWithLiveData) {
            if (p.type === 'vehicle' || !isValidSiteId(p.energy_site_id)) return;

            try {
                const data = await fetchSiteLiveData(p.energy_site_id, controller.signal);
                if (!isMounted) return;

                setProducts(prev => prev.map(prod => {
                    if (prod.id === p.id) {
                        return {
                            ...prod,
                            liveSolarPower: data.solarPower,
                            liveBatteryPower: data.batteryPower,
                            liveGridPower: data.gridPower,
                            liveLoadPower: data.loadPower,
                            percentage_charged: data.percentageCharged,
                            currentTariff: prod.currentTariff === 'Loading...' ? (data.currentTariff || 'Standard') : prod.currentTariff
                        };
                    }
                    return prod;
                }));
                setLastUpdate(new Date());
            } catch (e) {
                if (e instanceof DOMException && e.name === 'AbortError') {
                    return;
                }
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
            productsRef.current.forEach(p => {
                if (p.type !== 'vehicle') fetchLiveForProduct(p);
            });
        }, 60000);

        return () => {
            isMounted = false;
            clearTimeout(initialTimer);
            controller.abort();
            clearInterval(interval);
        };
    }, [initialProducts]);

    return (
        <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {products.map((product) => {
                    if (product.type === 'vehicle') {
                        const meta = product.meta as VehicleMeta | undefined;
                        return (
                            <SectionCard
                                key={product.id}
                                className="h-full bg-slate-50 transition-shadow hover:shadow-md dark:bg-slate-800"
                                title={(
                                    <span className="flex items-center gap-2">
                                        <VehicleIcon />
                                        <span>{product.site_name}</span>
                                    </span>
                                )}
                                action={<StatusPill status={meta?.state} className="font-mono" />}
                                bodyClassName="space-y-3"
                            >
                                <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                                    <div className="flex justify-between border-b border-gray-100 pb-1 dark:border-slate-700">
                                        <span className="text-gray-500">VIN</span>
                                        <span className="font-mono">{product.currentTariff}</span>
                                    </div>
                                    <div className="flex justify-between border-b border-gray-100 pb-1 dark:border-slate-700">
                                        <span className="text-gray-500">ID</span>
                                        <span className="font-mono">{meta?.vehicle_id}</span>
                                    </div>
                                    {meta?.option_codes ? (
                                        <div className="truncate text-xs text-gray-400" title={meta.option_codes}>
                                            Options: {meta.option_codes}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="flex justify-end border-t border-gray-100 pt-3 dark:border-slate-700">
                                    <span className="text-xs italic text-gray-400">
                                        Integrated via Tesla Fleet API
                                    </span>
                                </div>
                            </SectionCard>
                        );
                    }

                    return (
                        <Link
                            key={product.id}
                            href={`/site/${product.energy_site_id}/live`}
                            className="block"
                        >
                            <SectionCard
                                className="h-full cursor-pointer transition-shadow hover:shadow-md"
                                title={(
                                    <span className="flex items-center gap-2">
                                        <EnergySiteIcon />
                                        <span>{product.site_name}</span>
                                    </span>
                                )}
                                bodyClassName="space-y-3"
                            >
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
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
                                <p className="text-sm text-gray-500">Tariff: {formatTouName(product.currentTariff)}</p>
                            </SectionCard>
                        </Link>
                    );
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
