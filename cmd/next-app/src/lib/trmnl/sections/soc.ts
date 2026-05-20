import type { TrmnlSection } from './types';
import { renderSocChart, renderBatterySocGlyphStrip } from '../charts';
import * as components from '../components';

export const socSection: TrmnlSection = {
    id: 'soc',
    label: 'Battery Level',
    configKey: 'showBatterySoc',
    isEnabled: (l) => l.hasStandaloneSocChart || l.hasStandaloneSocGlyph,
    render: (ctx, l) => l.hasStandaloneSocChart ? `
            <div class="flex flex--row flex--center-x w--full" style="flex: 1 1 auto; height: ${l.socChartMinHeight}px; min-height: ${l.socChartMinHeight}px; align-items: stretch;">
                ${ctx.seriesData ? renderSocChart(ctx.seriesData, ctx.batterySoc, l.socChartMinHeight, {
            showXAxis: !l.showEnergyChart
        }) : '<span class="label">Battery SoC unavailable</span>'}
            </div>
        ` : `
            <div class="flex flex--row flex--center-x w--full" style="height: ${l.socGlyphSectionHeight}px; min-height: ${l.socGlyphSectionHeight}px; align-items: center;">
                <div class="flex flex--col w--full">
                    ${ctx.seriesData
                ? renderBatterySocGlyphStrip(ctx.seriesData, ctx.batterySoc, { showXAxis: !l.showEnergyChart })
                : components.renderBatterySocStandalone(ctx.batterySoc)}
                </div>
            </div>
        `
};
