import type { RenderContext } from '../types';
import type { LayoutState } from '../layout-engine';

export interface TrmnlSection {
    id: string;
    label: string;
    configKey: 'showLiveGrid' | 'showLiveSolar' | 'showLiveBattery'
        | 'showEnergyChart' | 'showBatterySoc' | 'showEstimatedBill'
        | 'showLoadTiming' | null;
    isEnabled(layout: LayoutState): boolean;
    render(ctx: RenderContext, layout: LayoutState): string;
}
