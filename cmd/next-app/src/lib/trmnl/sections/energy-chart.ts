import type { TrmnlSection } from './types';
import { renderEnergyChart } from '../charts';

export const energyChartSection: TrmnlSection = {
    id: 'energyChart',
    label: 'Energy Usage Chart',
    configKey: 'showEnergyChart',
    isEnabled: (l) => l.showEnergyChart,
    render: (ctx, l) => `
            <div class="flex flex--row flex--center-y flex--center-x w--full" style="flex: 1 1 auto; height: ${l.chartMinHeight}px; min-height: ${l.chartMinHeight}px;">
                ${ctx.seriesData ? renderEnergyChart(ctx.seriesData, {
            chartHeight: l.chartMinHeight,
            denseLegend: l.isDenseLayout || l.isVeryDenseLayout,
            veryDenseLegend: l.isVeryDenseLayout,
            timeZone: ctx.timezone
        }) : ''}
            </div>
        `
};
