'use client';

import { UsageData } from '@/lib/energy-repo';
import { Badge } from '@/components/ui/Badge';
import { SectionCard } from '@/components/ui/SectionCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';

import { formatTouName } from '../lib/format-utils';

interface BillSummaryProps {
    usage: UsageData[];
    activeTariffId?: number;
    activeTouName?: string;
    alwaysExpanded?: boolean;
    currencySymbol?: string;
}

interface BillPeriod {
    touName: string;
    home: number;
    grid: number;
    solar: number;
    battery: number;
    cost: number;
}

interface TariffGroup {
    tariffId: number;
    tariffName: string;
    periods: BillPeriod[];
}

interface BillTotals {
    home: number;
    grid: number;
    solar: number;
    battery: number;
    cost: number;
}

function formatKwh(value: number) {
    return `${(value / 1000).toFixed(2)} kWh`;
}

function formatCurrency(value: number, symbol = '$') {
    const abs = Math.abs(value).toFixed(2);
    return value >= 0 ? `${symbol}${abs}` : `-${symbol}${abs}`;
}

function formatCostLabel(value: number) {
    return value >= 0 ? 'Est. Cost' : 'Est. Credit';
}

function getTariffTotals(periods: BillPeriod[]): BillTotals {
    return periods.reduce<BillTotals>((totals, period) => ({
        home: totals.home + period.home,
        grid: totals.grid + period.grid,
        solar: totals.solar + period.solar,
        battery: totals.battery + period.battery,
        cost: totals.cost + period.cost,
    }), {
        home: 0,
        grid: 0,
        solar: 0,
        battery: 0,
        cost: 0,
    });
}

function groupUsageByTariff(usage: UsageData[]): TariffGroup[] {
    const tariffGroups = new Map<string, TariffGroup>();

    for (const item of usage) {
        const tariffName = item.tariff.name || 'Unknown';
        let group = tariffGroups.get(tariffName);

        if (!group) {
            group = {
                tariffId: item.tariff.id,
                tariffName,
                periods: [],
            };
            tariffGroups.set(tariffName, group);
        }

        group.periods.push({
            touName: item.touName || 'Standard',
            home: item.homeUsage,
            grid: item.gridUsage,
            solar: item.solarProduction,
            battery: item.batteryChange,
            cost: item.cost || 0,
        });
    }

    return Array.from(tariffGroups.values()).map((group) => ({
        ...group,
        periods: [...group.periods].sort((a, b) => a.touName.localeCompare(b.touName)),
    }));
}

function PeriodMetricsGrid({ period, emphasize = false }: { period: BillPeriod | BillTotals; emphasize?: boolean }) {
    const valueClass = emphasize ? 'font-semibold text-gray-900 dark:text-gray-50' : 'font-medium text-gray-900 dark:text-gray-100';

    return (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
            <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Home</p>
                <p className={`${valueClass} text-sm`}>{formatKwh(period.home)}</p>
            </div>
            <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Battery</p>
                <p className={`${valueClass} text-sm`}>{formatKwh(period.battery)}</p>
            </div>
            <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Solar</p>
                <p className={`${valueClass} text-sm`}>{formatKwh(period.solar)}</p>
            </div>
            <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Grid</p>
                <p className={`${valueClass} text-sm`}>{formatKwh(period.grid)}</p>
            </div>
        </div>
    );
}

export function BillSummary({ usage, activeTariffId, activeTouName, currencySymbol = '$' }: BillSummaryProps) {
    const tariffGroups = groupUsageByTariff(usage);

    return (
        <div className="grid gap-4 sm:gap-6">
            {tariffGroups.map((tariff) => {
                const isActiveTariff = activeTariffId !== undefined && tariff.tariffId === activeTariffId;
                const totals = getTariffTotals(tariff.periods);

                return (
                    <SectionCard
                        key={`${tariff.tariffId}-${tariff.tariffName}`}
                        density="compact"
                        title={(
                            <div className="flex items-center gap-2 min-w-0">
                                <span className="truncate">{tariff.tariffName}</span>
                            </div>
                        )}
                        description="Estimated monthly bill breakdown by TOU period"
                    >
                        <div className="space-y-3">
                            <div className="hidden md:block">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Period</TableHead>
                                            <TableHead className="text-right">Home</TableHead>
                                            <TableHead className="text-right">Battery</TableHead>
                                            <TableHead className="text-right">Solar</TableHead>
                                            <TableHead className="text-right">Grid</TableHead>
                                            <TableHead className="text-right">Estimated</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {tariff.periods.map((period, index) => {
                                            const isActiveTou = isActiveTariff && activeTouName === period.touName;

                                            return (
                                                <TableRow
                                                    key={`${period.touName}-${index}`}
                                                    className={isActiveTou ? 'bg-blue-50/60 dark:bg-blue-950/20' : ''}
                                                >
                                                    <TableCell>
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-medium text-gray-900 dark:text-gray-100">{formatTouName(period.touName)}</span>
                                                            {isActiveTou ? <Badge variant="info">Active</Badge> : null}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">{formatKwh(period.home)}</TableCell>
                                                    <TableCell className="text-right tabular-nums">{formatKwh(period.battery)}</TableCell>
                                                    <TableCell className="text-right tabular-nums">{formatKwh(period.solar)}</TableCell>
                                                    <TableCell className="text-right tabular-nums">{formatKwh(period.grid)}</TableCell>
                                                    <TableCell className="text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                                        {formatCurrency(period.cost, currencySymbol)}
                                                        <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">{formatCostLabel(period.cost)}</span>
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })}
                                        <TableRow className="bg-gray-50 dark:bg-slate-900/80">
                                            <TableCell className="font-semibold text-gray-900 dark:text-white">Total</TableCell>
                                            <TableCell className="text-right font-semibold tabular-nums">{formatKwh(totals.home)}</TableCell>
                                            <TableCell className="text-right font-semibold tabular-nums">{formatKwh(totals.battery)}</TableCell>
                                            <TableCell className="text-right font-semibold tabular-nums">{formatKwh(totals.solar)}</TableCell>
                                            <TableCell className="text-right font-semibold tabular-nums">{formatKwh(totals.grid)}</TableCell>
                                            <TableCell className="text-right font-bold tabular-nums text-gray-900 dark:text-gray-100">
                                                {formatCurrency(totals.cost, currencySymbol)}
                                                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">{formatCostLabel(totals.cost)}</span>
                                            </TableCell>
                                        </TableRow>
                                    </TableBody>
                                </Table>
                            </div>

                            <div className="md:hidden">
                                <div className="grid gap-3">
                                    {tariff.periods.map((period, index) => {
                                        const isActiveTou = isActiveTariff && activeTouName === period.touName;

                                        return (
                                            <div
                                                key={`${period.touName}-${index}`}
                                                className={`rounded-lg border p-3 space-y-3 ${isActiveTou ? 'border-blue-300 bg-blue-50/50 dark:border-blue-700 dark:bg-blue-950/20' : 'border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-950/20'}`}
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0 space-y-1">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <p className="font-medium text-gray-900 dark:text-white">{formatTouName(period.touName)}</p>
                                                            {isActiveTou ? <Badge variant="info">Active</Badge> : null}
                                                        </div>
                                                    </div>
                                                    <div className="text-right shrink-0">
                                                        <p className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(period.cost, currencySymbol)}</p>
                                                        <p className="text-xs text-gray-500 dark:text-gray-400">{formatCostLabel(period.cost)}</p>
                                                    </div>
                                                </div>
                                                <PeriodMetricsGrid period={period} />
                                            </div>
                                        );
                                    })}

                                    <div className="rounded-lg border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60 p-3 space-y-3">
                                        <div className="flex items-start justify-between gap-3">
                                            <div>
                                                <p className="font-semibold text-gray-900 dark:text-white">Total</p>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">Tariff total across all TOU periods</p>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <p className="font-bold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(totals.cost, currencySymbol)}</p>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">{formatCostLabel(totals.cost)}</p>
                                            </div>
                                        </div>
                                        <PeriodMetricsGrid period={totals} emphasize={true} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </SectionCard>
                );
            })}
        </div>
    );
}
