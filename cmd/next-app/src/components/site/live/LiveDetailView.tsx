import { Suspense } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import type { TodayTotals, UsageData } from '@/lib/energy-repo';
import type { EnergyData } from '@/lib/db';
import type { LoadTimingView } from '@/lib/load-timing';
import { DailyTotalsRow } from './DailyTotalsRow';
import { DailyByPeriodTable } from './DailyByPeriodTable';
import { PeriodCardRow } from './PeriodCardRow';
import { TodayEnergyChart } from './TodayEnergyChart';
import { HalfHourRefresh } from './HalfHourRefresh';
import { BatteryHoldCard } from './BatteryHoldCard';
import { SankeyCard } from './SankeyCard';
import { buildLoadAffordanceNow } from '@/lib/load-affordance-now';

export interface LiveDetailViewProps {
    siteId: string;
    siteName: string;
    siteTimezone: string;
    batterySoC: number | null;
    batteryPower: number;
    solarPower: number;
    gridPower: number;
    loadPower: number;
    today: UsageData[];
    todayTotals: TodayTotals;
    todayChartRows: EnergyData[];
    todayStart: Date;
    now: Date;
    hasTariff: boolean;
    loadTiming: LoadTimingView | null;
    batteryHold: { mode: 'auto' | 'timer'; target_reserve: number; original_reserve: number; created_at: string; safety_expires_at: string } | null;
    batteryNotice: { current: number } | null;
    sankeySnapshotSvg: string | null;
    sankeyCumulativeSvg: string | null;
}

export function LiveDetailView({
    siteId, siteName, siteTimezone,
    batterySoC, batteryPower,
    solarPower, gridPower, loadPower,
    today, todayTotals,
    todayChartRows, todayStart, now,
    hasTariff,
    loadTiming,
    batteryHold,
    batteryNotice,
    sankeySnapshotSvg,
    sankeyCumulativeSvg
}: LiveDetailViewProps) {

    const affordance = buildLoadAffordanceNow(loadTiming);

    return (
        <div className="space-y-6">
            <SectionCard title="Today so far" density="compact" bodyClassName="space-y-4">
                <DailyTotalsRow
                    totals={todayTotals}
                    soc={batterySoC}
                    batteryPower={batteryPower}
                    affordance={affordance}
                />
                <DailyByPeriodTable today={today} />
                <HalfHourRefresh />
            </SectionCard>

            <SectionCard title={`${siteName} — Today`} density="compact">
                <TodayEnergyChart
                    rows={todayChartRows}
                    todayStart={todayStart}
                    now={now}
                    timezone={siteTimezone}
                    currentPower={{
                        solar: solarPower,
                        grid: gridPower,
                        load: loadPower,
                        battery: batteryPower
                    }}
                />
            </SectionCard>

            <SectionCard title="Load timing this cycle" density="compact" bodyClassName="space-y-3">
                <PeriodCardRow
                    siteId={siteId}
                    hasTariff={hasTariff}
                    loadTiming={loadTiming}
                />
            </SectionCard>

            {sankeySnapshotSvg && sankeyCumulativeSvg && (
                <SankeyCard snapshotSvg={sankeySnapshotSvg} cumulativeSvg={sankeyCumulativeSvg} />
            )}

            <Suspense fallback={
                <SectionCard title="Hold battery for charging" density="compact">
                    <p className="text-sm text-gray-500">Loading battery control...</p>
                </SectionCard>
            }>
                <BatteryHoldCard
                    siteId={siteId}
                    soc={batterySoC}
                    hasTariff={hasTariff}
                    initialHold={batteryHold}
                    initialNotice={batteryNotice}
                />
            </Suspense>
        </div>
    );
}
