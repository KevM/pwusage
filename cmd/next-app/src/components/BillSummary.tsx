'use client';

import React, { useState, useEffect } from 'react';
import { UsageData } from '@/lib/energy-repo';

import { formatTouName } from '../lib/format-utils';

interface BillSummaryProps {
    usage: UsageData[];
    activeTariffId?: number;
    activeTouName?: string;
    alwaysExpanded?: boolean;
}

export function BillSummary({ usage, activeTariffId, activeTouName, alwaysExpanded = false }: BillSummaryProps) {
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
            buyRate?: number;
            sellRate?: number;
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
            cost: u.cost || 0,
            buyRate: u.buyRate,
            sellRate: u.sellRate
        });
    });

    const [expandedPeriods, setExpandedPeriods] = useState<Set<string>>(() => {
        const initial = new Set<string>();
        if (activeTouName) {
            tariffGroups.forEach(group => {
                if (!activeTariffId || group.tariffId === activeTariffId) {
                    group.periods.forEach(p => {
                        if (p.touName === activeTouName) {
                            initial.add(`${group.tariffName}-${p.touName}`);
                        }
                    });
                }
            });
        }
        return initial;
    });

    const togglePeriod = (key: string) => {
        if (alwaysExpanded) return;
        setExpandedPeriods(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    return (
        <div className="grid gap-6">
            {Array.from(tariffGroups.values()).map((t) => {
                const isActive = activeTariffId !== undefined && t.tariffId === activeTariffId;
                return (
                    <div
                        key={t.tariffName}
                        className={`border p-4 sm:p-6 rounded shadow bg-white dark:bg-slate-900 relative ${isActive ? 'ring-2 ring-blue-500' : ''}`}
                    >
                        {isActive && (
                            <div className="absolute top-4 right-4 bg-blue-500 text-white text-xs font-bold px-2 py-1 rounded uppercase tracking-wide">
                                Active
                            </div>
                        )}
                        <h3 className="text-xl font-semibold mb-4">{t.tariffName}</h3>

                        <div className="space-y-2">
                            {t.periods.sort((a, b) => a.touName.localeCompare(b.touName)).map((p, idx) => {
                                const isActiveTou = isActive && activeTouName && p.touName === activeTouName;
                                const uniqueKey = `${t.tariffName}-${p.touName}`;
                                const isExpanded = alwaysExpanded || expandedPeriods.has(uniqueKey);

                                return (
                                    <div key={`${p.touName}-${idx}`} className={`pt-1`}>
                                        <div
                                            onClick={() => togglePeriod(uniqueKey)}
                                            className={`flex justify-between items-center p-2 -mx-2 rounded transition-colors ${alwaysExpanded ? '' : 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50'} ${isActiveTou ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}
                                        >
                                            <div className="flex items-center gap-2">
                                                {/* Chevron */}
                                                {!alwaysExpanded && (
                                                    <div
                                                        className="transition-transform duration-200 text-gray-400 w-5 h-5 flex items-center justify-center"
                                                        style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                                                    >
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="m9 18 6-6-6-6" />
                                                        </svg>
                                                    </div>
                                                )}

                                                <h4 className="font-medium text-lg">{formatTouName(p.touName)}</h4>
                                                {isActiveTou && (
                                                    <span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full font-medium dark:bg-blue-900 dark:text-blue-200">
                                                        Active
                                                    </span>
                                                )}
                                            </div>
                                            {!isExpanded && (
                                                <div className="text-right">
                                                    <span className={`font-bold ${p.cost >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                                                        {p.cost >= 0 ? '$' : '-$'}
                                                        {Math.abs(p.cost).toFixed(2)}
                                                    </span>
                                                    <span className="text-xs text-gray-500 block">
                                                        {p.cost >= 0 ? 'Est. Cost' : 'Est. Credit'}
                                                    </span>
                                                </div>
                                            )}
                                        </div>

                                        {isExpanded && (
                                            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-start sm:justify-between gap-4 px-4 pb-2 mt-4 w-full">
                                                {/* Home Usage */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        <p className="text-sm text-gray-500">Home Usage</p>
                                                    </div>
                                                    <div className="sm:hidden">
                                                        <p className="text-sm text-gray-500">Home Usage</p>
                                                    </div>
                                                    <p className="text-lg font-medium text-blue-700">{(p.home / 1000).toFixed(2)} kWh</p>
                                                </div>

                                                {/* Plus */}
                                                <div className="hidden sm:flex sm:flex-col sm:items-center sm:flex-none">
                                                    <div className="h-10 mb-1" />
                                                    <div className="text-2xl font-bold text-gray-400">+</div>
                                                </div>

                                                {/* Battery Charge */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="flex items-center sm:hidden">
                                                        <span className="text-xl font-bold text-gray-400 mr-2 w-4 flex-none">+</span>
                                                        <p className="text-sm text-gray-500">Battery Charge</p>
                                                    </div>
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        <p className="text-sm text-gray-500">Battery Charge</p>
                                                    </div>
                                                    <p className="text-lg font-medium text-purple-700">{(p.battery / 1000).toFixed(2)} kWh</p>
                                                </div>

                                                {/* Minus */}
                                                <div className="hidden sm:flex sm:flex-col sm:items-center sm:flex-none">
                                                    <div className="h-10 mb-1" />
                                                    <div className="text-2xl font-bold text-gray-400">−</div>
                                                </div>

                                                {/* Solar Production */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="flex items-center sm:hidden">
                                                        <span className="text-xl font-bold text-gray-400 mr-2 w-4 flex-none">−</span>
                                                        <div>
                                                            <p className="text-sm text-gray-500">Solar Production</p>
                                                            {p.sellRate !== undefined && <p className="text-[10px] text-gray-400">@ ${p.sellRate.toFixed(2)}</p>}
                                                        </div>
                                                    </div>
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        {p.sellRate !== undefined && <p className="text-[10px] text-gray-400 leading-tight">@ ${p.sellRate.toFixed(2)}</p>}
                                                        <p className="text-sm text-gray-500 leading-tight">Solar Production</p>
                                                    </div>
                                                    <p className="text-lg font-medium text-amber-700">{(p.solar / 1000).toFixed(2)} kWh</p>
                                                </div>

                                                {/* Equals */}
                                                <div className="hidden sm:flex sm:flex-col sm:items-center sm:flex-none">
                                                    <div className="h-10 mb-1" />
                                                    <div className="text-2xl font-bold text-gray-400">=</div>
                                                </div>

                                                {/* Grid Usage */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="flex items-center sm:hidden">
                                                        <span className="text-xl font-bold text-gray-400 mr-2 w-4 flex-none">=</span>
                                                        <div>
                                                            <p className="text-sm text-gray-500">Grid Usage</p>
                                                            {p.buyRate !== undefined && <p className="text-[10px] text-gray-400">@ ${p.buyRate.toFixed(2)}</p>}
                                                        </div>
                                                    </div>
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        {p.buyRate !== undefined && <p className="text-[10px] text-gray-400 leading-tight">@ ${p.buyRate.toFixed(2)}</p>}
                                                        <p className="text-sm text-gray-500 leading-tight">Grid Usage</p>
                                                    </div>
                                                    <p className="text-lg font-medium text-orange-700">{(p.grid / 1000).toFixed(2)} kWh</p>
                                                </div>

                                                {/* Arrow */}
                                                <div className="hidden sm:flex sm:flex-col sm:items-center sm:flex-none">
                                                    <div className="h-10 mb-1" />
                                                    <div className="text-2xl font-bold text-slate-300 dark:text-slate-700">&rarr;</div>
                                                </div>

                                                {/* Cost */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="flex items-center sm:hidden">
                                                        <span className="text-xl font-bold text-slate-300 mr-2 w-4 flex-none">&rarr;</span>
                                                        <p className="text-sm text-gray-500">{p.cost >= 0 ? 'Est. Cost' : 'Est. Credit'}</p>
                                                    </div>
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        <p className="text-sm text-gray-500">{p.cost >= 0 ? 'Est. Cost' : 'Est. Credit'}</p>
                                                    </div>
                                                    <p className={`text-lg font-bold ${p.cost >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                                                        {p.cost >= 0 ? '$' : '-$'}
                                                        {Math.abs(p.cost).toFixed(2)}
                                                    </p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {/* Total Row */}
                            {(() => {
                                const totalHome = t.periods.reduce((sum, p) => sum + p.home, 0);
                                const totalBattery = t.periods.reduce((sum, p) => sum + p.battery, 0);
                                const totalSolar = t.periods.reduce((sum, p) => sum + p.solar, 0);
                                const totalGrid = t.periods.reduce((sum, p) => sum + p.grid, 0);
                                const totalCost = t.periods.reduce((sum, p) => sum + p.cost, 0);

                                const totalKey = `${t.tariffName}-Total`;
                                const isTotalExpanded = alwaysExpanded || expandedPeriods.has(totalKey);

                                return (
                                    <div className="mt-4">
                                        <div
                                            onClick={() => togglePeriod(totalKey)}
                                            className={`flex justify-between items-center px-2 -mx-2 rounded transition-colors ${alwaysExpanded ? '' : 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
                                        >
                                            <div className="flex items-center gap-2">
                                                {/* Chevron */}
                                                {!alwaysExpanded && (
                                                    <div
                                                        className="transition-transform duration-200 text-gray-400 w-5 h-5 flex items-center justify-center"
                                                        style={{ transform: isTotalExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                                                    >
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="m9 18 6-6-6-6" />
                                                        </svg>
                                                    </div>
                                                )}
                                                <h4 className="font-bold text-lg text-gray-900 dark:text-gray-100">Total</h4>
                                            </div>

                                            {!isTotalExpanded && (
                                                <div className="text-right">
                                                    <span className={`font-bold text-lg ${totalCost >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                                                        {totalCost >= 0 ? '$' : '-$'}
                                                        {Math.abs(totalCost).toFixed(2)}
                                                    </span>
                                                    <span className="text-xs text-gray-500 block">
                                                        {totalCost >= 0 ? 'Est. Cost' : 'Est. Credit'}
                                                    </span>
                                                </div>
                                            )}
                                        </div>

                                        {isTotalExpanded && (
                                            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-start sm:justify-between gap-4 px-4 pb-2 mt-4 w-full">
                                                {/* Home Usage */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        <p className="text-sm text-gray-500">Home Usage</p>
                                                    </div>
                                                    <div className="sm:hidden">
                                                        <p className="text-sm text-gray-500">Home Usage</p>
                                                    </div>
                                                    <p className="text-lg font-bold text-blue-700">{(totalHome / 1000).toFixed(2)} kWh</p>
                                                </div>

                                                {/* Plus */}
                                                <div className="hidden sm:flex sm:flex-col sm:items-center sm:flex-none">
                                                    <div className="h-10 mb-1" />
                                                    <div className="text-2xl font-bold text-gray-400">+</div>
                                                </div>

                                                {/* Battery Charge */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="flex items-center sm:hidden">
                                                        <span className="text-xl font-bold text-gray-400 mr-2 w-4 flex-none">+</span>
                                                        <p className="text-sm text-gray-500">Battery Charge</p>
                                                    </div>
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        <p className="text-sm text-gray-500">Battery Charge</p>
                                                    </div>
                                                    <p className="text-lg font-bold text-purple-700">{(totalBattery / 1000).toFixed(2)} kWh</p>
                                                </div>

                                                {/* Minus */}
                                                <div className="hidden sm:flex sm:flex-col sm:items-center sm:flex-none">
                                                    <div className="h-10 mb-1" />
                                                    <div className="text-2xl font-bold text-gray-400">−</div>
                                                </div>

                                                {/* Solar Production */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="flex items-center sm:hidden">
                                                        <span className="text-xl font-bold text-gray-400 mr-2 w-4 flex-none">−</span>
                                                        <div>
                                                            <p className="text-sm text-gray-500">Solar Production</p>
                                                        </div>
                                                    </div>
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        <p className="text-sm text-gray-500 leading-tight">Solar Production</p>
                                                    </div>
                                                    <p className="text-lg font-bold text-amber-700">{(totalSolar / 1000).toFixed(2)} kWh</p>
                                                </div>

                                                {/* Equals */}
                                                <div className="hidden sm:flex sm:flex-col sm:items-center sm:flex-none">
                                                    <div className="h-10 mb-1" />
                                                    <div className="text-2xl font-bold text-gray-400">=</div>
                                                </div>

                                                {/* Grid Usage */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="flex items-center sm:hidden">
                                                        <span className="text-xl font-bold text-gray-400 mr-2 w-4 flex-none">=</span>
                                                        <div>
                                                            <p className="text-sm text-gray-500">Grid Usage</p>
                                                        </div>
                                                    </div>
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        <p className="text-sm text-gray-500 leading-tight">Grid Usage</p>
                                                    </div>
                                                    <p className="text-lg font-bold text-orange-700">{(totalGrid / 1000).toFixed(2)} kWh</p>
                                                </div>

                                                {/* Arrow */}
                                                <div className="hidden sm:flex sm:flex-col sm:items-center sm:flex-none">
                                                    <div className="h-10 mb-1" />
                                                    <div className="text-2xl font-bold text-slate-300 dark:text-slate-700">&rarr;</div>
                                                </div>

                                                {/* Cost */}
                                                <div className="flex justify-between items-center sm:flex sm:flex-col sm:items-start sm:flex-1 sm:w-auto w-full">
                                                    <div className="flex items-center sm:hidden">
                                                        <span className="text-xl font-bold text-slate-300 mr-2 w-4 flex-none">&rarr;</span>
                                                        <p className="text-sm text-gray-500">{totalCost >= 0 ? 'Est. Cost' : 'Est. Credit'}</p>
                                                    </div>
                                                    <div className="hidden sm:flex sm:flex-col sm:justify-end sm:h-10 sm:mb-1">
                                                        <p className="text-sm text-gray-500">{totalCost >= 0 ? 'Est. Cost' : 'Est. Credit'}</p>
                                                    </div>
                                                    <p className={`text-lg font-bold ${totalCost >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                                                        {totalCost >= 0 ? '$' : '-$'}
                                                        {Math.abs(totalCost).toFixed(2)}
                                                    </p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
