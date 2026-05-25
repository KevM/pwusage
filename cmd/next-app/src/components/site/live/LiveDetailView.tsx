import { SectionCard } from '@/components/ui/SectionCard';
import type { TodayTotals, UsageData } from '@/lib/energy-repo';
import type { EnergyData } from '@/lib/db';
import type { CheaperPeriod } from '@/lib/next-cheaper-period';
import { DailyTotalsRow } from './DailyTotalsRow';
import { DailyByPeriodTable } from './DailyByPeriodTable';
import { PeriodCardRow, type ActivePeriod } from './PeriodCardRow';
import { TodayEnergyChart } from './TodayEnergyChart';
import { HalfHourRefresh } from './HalfHourRefresh';
import { BatteryHoldCard } from './BatteryHoldCard';

export interface LiveDetailViewProps {
    siteId: string;
    siteName: string;
    siteTimezone: string;
    batterySoC: number | null;
    batteryPower: number;
    solarPower: number;
    gridPower: number;
    loadPower: number;
    cycle: UsageData[];
    today: UsageData[];
    todayTotals: TodayTotals;
    todayChartRows: EnergyData[];
    todayStart: Date;
    now: Date;
    activePeriod: ActivePeriod | null;
    hasTariff: boolean;
    nextCheaper: CheaperPeriod | null;
    nextCheaperPhrase: string | null;
    nextStartPhraseByKey?: Record<string, string>;
    activeIsCheapest?: boolean;
    batteryHold: { mode: 'auto' | 'timer'; target_reserve: number; original_reserve: number; created_at: string; safety_expires_at: string } | null;
    batteryNotice: { current: number } | null;
}

export function LiveDetailView({
    siteId, siteName, siteTimezone,
    batterySoC, batteryPower,
    solarPower, gridPower, loadPower,
    cycle, today, todayTotals,
    todayChartRows, todayStart, now,
    activePeriod, hasTariff,
    nextCheaper, nextCheaperPhrase,
    nextStartPhraseByKey, activeIsCheapest,
    batteryHold,
    batteryNotice
}: LiveDetailViewProps) {


    return (
        <div className="space-y-6">
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

            <SectionCard title="Today so far" density="compact" bodyClassName="space-y-4">
                <DailyTotalsRow
                    totals={todayTotals}
                    soc={batterySoC}
                    batteryPower={batteryPower}
                />
                <DailyByPeriodTable today={today} />
                <HalfHourRefresh />
            </SectionCard>

            <SectionCard title="Load timing this cycle" density="compact" bodyClassName="space-y-3">
                <PeriodCardRow
                    siteId={siteId}
                    cycle={cycle}
                    activePeriod={activePeriod}
                    hasTariff={hasTariff}
                    nextCheaper={nextCheaper}
                    nextCheaperPhrase={nextCheaperPhrase}
                    nextStartPhraseByKey={nextStartPhraseByKey}
                    activeIsCheapest={activeIsCheapest}
                />
            </SectionCard>

            <BatteryHoldCard
                siteId={siteId}
                soc={batterySoC}
                hasTariff={hasTariff}
                initialHold={batteryHold}
                initialNotice={batteryNotice}
            />
        </div>
    );
}
