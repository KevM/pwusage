import { DEFAULT_TRMNL_COMPONENT_CONFIG } from './trmnl-component-config';
import { getSunIcon, getGridIcon } from './trmnl/icons';
import { calculateLayoutBudget } from './trmnl/layout-engine';
import { renderEnergyChart, renderSocChart, renderBatterySocGlyphStrip } from './trmnl/charts';
import { RenderContext } from './trmnl/types';
import * as components from './trmnl/components';

export type { RenderContext, TariffGroup } from './trmnl/types';

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export class TrmnlRenderer {
    static renderFull(ctx: RenderContext): string {
        const start = Date.now();
        const cfg = ctx.componentConfig ?? DEFAULT_TRMNL_COMPONENT_CONFIG;
        const layout = calculateLayoutBudget(ctx, cfg);

        const {
            hasStandaloneSocChart,
            hasStandaloneSocGlyph,
            showLiveGridStat,
            showLiveSolarStat,
            showLiveBatteryStat,
            hasLiveRow,
            showEnergyChart,
            showEstimatedBill,
            showBatterySoc,
            isVeryDenseLayout,
            isDenseLayout,
            compactBillMode,
            liveIconSize,
            liveValueFontPx,
            liveGap,
            liveBatteryScale,
            liveRowHeight,
            chartMinHeight,
            socChartMinHeight,
            socGlyphSectionHeight,
            billRowsTarget,
            billCompactLevel,
            showBillMetaHeader,
            showSiteNameInLiveRow
        } = layout;

        const tariffTables = components.renderTariffTables(ctx, billRowsTarget, billCompactLevel);

        const liveStatsSection = hasLiveRow ? `
            <div class="w--full" style="position: relative; height: ${liveRowHeight}px; min-height: ${liveRowHeight}px;">
                ${showSiteNameInLiveRow ? `
                <span class="label label--small" style="position: absolute; top: 2px; left: 2px; line-height: 1; z-index: 2;">${escapeHtml(ctx.siteName)}</span>
                ` : ''}
                <div class="flex flex--row flex--center-y flex--center-x ${liveGap}" style="height: 100%;">
                    ${showLiveGridStat ? `
                    <div class="flex flex--row flex--center-y flex--center-x gap--small">
                        <span class="title title--xxlarge" style="font-size: ${liveValueFontPx}px; line-height: 1;">${(ctx.todayGrid as number).toFixed(1)}</span>
                        ${getGridIcon(liveIconSize)}
                    </div>
                    ` : ''}

                    ${showLiveSolarStat ? `
                    <div class="flex flex--row flex--center-y flex--center-x gap--small">
                        <span class="title title--xxlarge" style="font-size: ${liveValueFontPx}px; line-height: 1;">${(ctx.todaySolar as number).toFixed(1)}</span>
                        ${getSunIcon(liveIconSize)}
                    </div>
                    ` : ''}

                    ${showLiveBatteryStat ? `
                    <div class="flex flex--col flex--center-x">
                        ${components.renderBatteryStatusLarge(ctx.batterySoc, ctx.batteryStatus, { scale: liveBatteryScale })}
                    </div>
                    ` : ''}
                </div>
            </div>
        ` : '';

        const chartSection = showEnergyChart ? `
            <div class="flex flex--row flex--center-y flex--center-x w--full" style="flex: 1 1 auto; height: ${chartMinHeight}px; min-height: ${chartMinHeight}px;">
                ${ctx.seriesData ? renderEnergyChart(ctx.seriesData, {
            chartHeight: chartMinHeight,
            denseLegend: isDenseLayout || isVeryDenseLayout,
            veryDenseLegend: isVeryDenseLayout
        }) : ''}
            </div>
        ` : '';

        const standaloneSocSection = hasStandaloneSocChart ? `
            <div class="flex flex--row flex--center-x w--full" style="flex: 1 1 auto; height: ${socChartMinHeight}px; min-height: ${socChartMinHeight}px; align-items: stretch;">
                ${ctx.seriesData ? renderSocChart(ctx.seriesData, ctx.batterySoc, socChartMinHeight, {
            showXAxis: !showEnergyChart
        }) : '<span class="label">Battery SoC unavailable</span>'}
            </div>
        ` : (hasStandaloneSocGlyph ? `
            <div class="flex flex--row flex--center-x w--full" style="height: ${socGlyphSectionHeight}px; min-height: ${socGlyphSectionHeight}px; align-items: center;">
                <div class="flex flex--col w--full">
                    ${ctx.seriesData
                ? renderBatterySocGlyphStrip(ctx.seriesData, ctx.batterySoc, { showXAxis: !showEnergyChart })
                : components.renderBatterySocStandalone(ctx.batterySoc)}
                </div>
            </div>
        ` : '');

        const billSection = showEstimatedBill ? `
            <div class="flex flex--col w--full">
                ${showBillMetaHeader ? `
                <div class="flex flex--row flex--center-y w--full" style="justify-content: space-between; margin-bottom: 4px;">
                    <span class="title title--small" style="font-size: ${compactBillMode ? 15 : 17}px; line-height: 1;">${escapeHtml(ctx.siteName)}</span>
                    <span class="value value--small" style="font-size: ${compactBillMode ? 13 : 15}px; font-weight: 700; line-height: 1;">${escapeHtml(ctx.dateRange)}</span>
                </div>
                ` : ''}
                ${tariffTables}
            </div>
        ` : '';

        const emptySection = (!hasLiveRow && !showEnergyChart && !showBatterySoc && !showEstimatedBill) ? `
            <div class="flex flex--row flex--center-x flex--center-y h--full">
                <span class="title title--medium">No components selected</span>
            </div>
        ` : '';

        const markup = `
            <div class="view view--full">
                <div class="layout layout--col gap--small h--full">
                    ${liveStatsSection}
                    ${chartSection}
                    ${standaloneSocSection}
                    ${billSection}
                    ${emptySection}

                     ${!showEstimatedBill ? `
                     <div class="flex flex--row flex--center-x flex--center-y gap--medium">
                         <span class="title title--small">${escapeHtml(ctx.siteName)}</span>
                         <span class="label label--small">${escapeHtml(ctx.dateRange)}</span>
                     </div>
                     ` : ''}
                </div>
            </div>
        `;
        const renderDuration = Date.now() - start;
        console.log(`[TrmnlRenderer] renderFull completed in ${renderDuration}ms`);
        return markup;
    }

    static renderHalfVertical(ctx: RenderContext): string {
        return components.renderHalfVertical(ctx);
    }

    static renderHalfHorizontal(ctx: RenderContext): string {
        return components.renderHalfHorizontal(ctx);
    }

    static renderQuadrant(ctx: RenderContext): string {
        return components.renderQuadrant(ctx);
    }




}
