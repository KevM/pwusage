import React from 'react';
import { UsageData } from '@/lib/energy-repo';

import { formatTouName } from '../lib/format-utils';

interface BillSummaryProps {
    usage: UsageData[];
    activeTariffId?: number;
}

export function BillSummary({ usage, activeTariffId }: BillSummaryProps) {
    // Group by tariff and then by TOU
    const tariffGroups = new Map<string, {
        tariffId: number;
        tariffName: string;
        periods: {
            touName: string;
            home: number;
            grid: number;
            solar: number;
            battery: number;
            cost: number;
        }[];
    }>();

    usage.forEach(u => {
        const tName = u.tariff.name || 'Unknown';
        let group = tariffGroups.get(tName);
        if (!group) {
            group = { tariffId: u.tariff.id, tariffName: tName, periods: [] };
            tariffGroups.set(tName, group);
        }
        group.periods.push({
            touName: u.touName || 'Standard',
            home: u.homeUsage,
            grid: u.gridUsage,
            solar: u.solarProduction,
            battery: u.batteryChange,
            cost: u.cost || 0
        });
    });

    return (
        <div className="grid gap-6">
            {Array.from(tariffGroups.values()).map((t) => {
                const isActive = activeTariffId !== undefined && t.tariffId === activeTariffId;
                return (
                    <div
                        key={t.tariffName}
                        className={`border p-6 rounded shadow bg-white dark:bg-slate-900 relative ${isActive ? 'ring-2 ring-blue-500' : ''}`}
                    >
                        {isActive && (
                            <div className="absolute top-4 right-4 bg-blue-500 text-white text-xs font-bold px-2 py-1 rounded uppercase tracking-wide">
                                Active
                            </div>
                        )}
                        <h3 className="text-xl font-semibold mb-4">{t.tariffName}</h3>

                        <div className="space-y-6">
                            {t.periods.sort((a, b) => a.touName.localeCompare(b.touName)).map((p) => (
                                <div key={p.touName} className="border-t pt-4 first:border-t-0 first:pt-0">
                                    <div className="flex justify-between items-center mb-2">
                                        <h4 className="font-medium text-lg">{formatTouName(p.touName)}</h4>
                                        <div className="text-right">
                                            <span className={`font-bold ${p.cost >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                                                {p.cost >= 0 ? '$' : '-$'}
                                                {Math.abs(p.cost).toFixed(2)}
                                            </span>
                                            <span className="text-xs text-gray-500 block">
                                                {p.cost >= 0 ? 'Est. Cost' : 'Est. Credit'}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-2 items-center">

                                        <div>
                                            <p className="text-sm text-gray-500">Home Usage</p>
                                            <p className="text-lg font-medium text-blue-700">{(p.home / 1000).toFixed(2)} kWh</p>
                                        </div>

                                        <div className="text-2xl font-bold text-gray-400 text-center">+</div>

                                        <div>
                                            <p className="text-sm text-gray-500">Battery Charge</p>
                                            <p className="text-lg font-medium text-purple-700">{(p.battery / 1000).toFixed(2)} kWh</p>
                                        </div>

                                        <div className="text-2xl font-bold text-gray-400 text-center">−</div>

                                        <div>
                                            <p className="text-sm text-gray-500">Solar Production</p>
                                            <p className="text-lg font-medium text-amber-700">{(p.solar / 1000).toFixed(2)} kWh</p>
                                        </div>

                                        <div className="text-2xl font-bold text-gray-400 text-center">=</div>

                                        <div>
                                            <p className="text-sm text-gray-500">Grid Usage</p>
                                            <p className="text-lg font-medium text-orange-700">{(p.grid / 1000).toFixed(2)} kWh</p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
