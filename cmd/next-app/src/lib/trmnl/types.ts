import { EnergyData } from '../db';
import { TrmnlComponentConfig } from '../trmnl-component-config';
import type { LoadTimingView } from '../load-timing';

export interface TariffGroup {
    tariffId: number;
    tariffName: string;
    periods: {
        touName: string;
        label: string;
        home: number;
        grid: number;
        solar: number;
        battery: number;
        cost: number;
    }[];
}

export interface RenderContext {
    siteName: string;
    dateRange: string;
    tariffGroups: TariffGroup[];
    totalCost: number;
    currency: string;
    displayCost: string;
    costLabel: string;
    currentTouName?: string;
    batterySoc?: number | null;
    batteryStatus?: 'charging' | 'discharging' | 'idle';
    todayHome?: number;
    todayGrid?: number;
    todaySolar?: number;
    seriesData?: EnergyData[];
    componentConfig?: TrmnlComponentConfig;
    loadTiming?: LoadTimingView;
}
