import { EnergyData } from './db';
import { energyToAveragePower, wattsToKilowatts, kilowattsToWatts } from './energy-utils';
import { buildSocCheckpoints, SocSample } from './soc-checkpoints';
import { DEFAULT_TRMNL_COMPONENT_CONFIG, TrmnlComponentConfig } from './trmnl-component-config';

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
    todayGrid?: number;
    todaySolar?: number;
    seriesData?: EnergyData[];
    componentConfig?: TrmnlComponentConfig;
}

export class TrmnlRenderer {
    private static readonly CHART_FONT_FAMILY = 'Verdana, Arial, sans-serif';

    static get SUN_ICON() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" fill="black" stroke="none"/><line x1="12" y1="1" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" /></svg>`;
    }

    static get SUN_ICON_LARGE() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" fill="black" stroke="none"/><line x1="12" y1="1" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" /></svg>`;
    }

    static get GRID_ICON() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 12 24" width="40" height="40"><path d="M7 2v11h3v9l7-12h-4l4-8z" fill="black"/></svg>`;
    }

    static get GRID_ICON_LARGE() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 12 24" width="48" height="48"><path d="M7 2v11h3v9l7-12h-4l4-8z" fill="black"/></svg>`;
    }

    static get CHARGING_ICON() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32" fill="black"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" transform="rotate(-90, 12, 12)"/></svg>`;
    }

    static get CHARGING_ICON_LARGE() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="40" height="40" fill="black"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" transform="rotate(-90, 12, 12)"/></svg>`;
    }

    static get DISCHARGING_ICON() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="black" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10M3 12h18M7 16h10M10 20h4" transform="rotate(-90, 12, 12)" /></svg>`;
    }

    static get DISCHARGING_ICON_LARGE() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="black" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10M3 12h18M7 16h10M10 20h4" transform="rotate(-90, 12, 12)" /></svg>`;
    }

    static renderFull(ctx: RenderContext): string {
        const start = Date.now();
        const cfg = ctx.componentConfig ?? DEFAULT_TRMNL_COMPONENT_CONFIG;

        const showLiveGrid = cfg.showLiveGrid;
        const showLiveSolar = cfg.showLiveSolar;
        const showLiveBattery = cfg.showLiveBattery;
        const showEnergyChart = cfg.showEnergyChart;
        const showBatterySoc = cfg.showBatterySoc;
        const showEstimatedBill = cfg.showEstimatedBill;

        const hasStandaloneSocChart = showBatterySoc && cfg.batterySocMode === 'chart';
        const hasStandaloneSocGlyph = !hasStandaloneSocChart && showBatterySoc;
        const showLiveGridStat = showLiveGrid && ctx.todayGrid !== undefined;
        const showLiveSolarStat = showLiveSolar && ctx.todaySolar !== undefined;
        const showLiveBatteryStat = showLiveBattery;
        const visibleLiveStatCount = [showLiveGridStat, showLiveSolarStat, showLiveBatteryStat]
            .filter(Boolean)
            .length;
        const hasLiveRow = visibleLiveStatCount > 0;
        const hasStandaloneSocSection = hasStandaloneSocChart || hasStandaloneSocGlyph;
        const activeSectionCount = (hasLiveRow ? 1 : 0)
            + (showEnergyChart ? 1 : 0)
            + (hasStandaloneSocSection ? 1 : 0)
            + (showEstimatedBill ? 1 : 0);
        const isVeryDenseLayout = activeSectionCount >= 4;
        const isDenseLayout = activeSectionCount === 3;
        const compactBillMode = showEstimatedBill && activeSectionCount >= 3;
        const isLiveEnergyBillLayout = showEstimatedBill && hasLiveRow && showEnergyChart && !hasStandaloneSocSection;

        const liveDensityScale = isLiveEnergyBillLayout
            ? 0.82
            : (isVeryDenseLayout ? 0.82 : (isDenseLayout ? 0.92 : 1));
        const liveIconSizeBase = visibleLiveStatCount <= 1 ? 72 : (visibleLiveStatCount === 2 ? 64 : 56);
        const liveValueFontBase = visibleLiveStatCount <= 1 ? 74 : (visibleLiveStatCount === 2 ? 64 : 56);
        const liveIconSize = Math.round(liveIconSizeBase * liveDensityScale);
        const liveValueFontPx = Math.round(liveValueFontBase * liveDensityScale);
        const liveGap = 'gap--xxlarge';
        const liveBatteryScaleBase = visibleLiveStatCount <= 1 ? 1.16 : (visibleLiveStatCount === 2 ? 1.05 : 0.92);
        const liveBatteryScale = liveBatteryScaleBase * liveDensityScale;
        const liveRowHeight = hasLiveRow ? (isVeryDenseLayout ? 64 : (isDenseLayout ? 74 : 88)) : 0;

        let chartMinHeight = isVeryDenseLayout
            ? (hasStandaloneSocGlyph ? 138 : 128)
            : (showEstimatedBill
            ? (hasLiveRow ? 160 : 210)
            : (hasStandaloneSocChart
                ? (hasLiveRow ? 176 : 230)
                : (hasLiveRow ? 250 : 310)));
        if (isLiveEnergyBillLayout) {
            chartMinHeight = 140;
        }
        let socChartMinHeight = isVeryDenseLayout
            ? 76
            : (!showEnergyChart
                ? (showEstimatedBill ? (hasLiveRow ? 150 : 170) : 220)
                : (showEstimatedBill ? 102 : 92));
        const isSocOnlyLayout = hasStandaloneSocChart && !showEnergyChart && !showEstimatedBill && !hasLiveRow;
        const isLiveSocOnlyLayout = hasStandaloneSocChart && !showEnergyChart && !showEstimatedBill && hasLiveRow;
        if (isSocOnlyLayout) {
            // Use the available TRMNL height budget so standalone SoC charts expand fully.
            const trmnlHeight = 480;
            const footerHeight = 24;
            const gapHeight = 8; // SoC chart + footer
            socChartMinHeight = Math.max(220, trmnlHeight - footerHeight - gapHeight);
        } else if (isLiveSocOnlyLayout) {
            // Fill remaining height when only live row + SoC chart + footer are visible.
            const trmnlHeight = 480;
            const footerHeight = 24;
            const gapHeight = 16; // live row + SoC chart + footer
            socChartMinHeight = Math.max(220, trmnlHeight - liveRowHeight - footerHeight - gapHeight);
        }
        const socGlyphSectionHeight = hasStandaloneSocGlyph ? (isVeryDenseLayout ? 28 : 24) : 0;
        const liveSectionHeightEstimate = liveRowHeight;
        const footerHeightEstimate = 24;
        const estimatedGap = 8;

        let billRowsTarget = 3;
        if (showEstimatedBill) {
            const trmnlHeight = 480;
            const nonBillSectionsHeight =
                liveSectionHeightEstimate +
                (showEnergyChart ? chartMinHeight : 0) +
                (hasStandaloneSocChart ? socChartMinHeight : socGlyphSectionHeight) +
                footerHeightEstimate;
            const renderedSections = (hasLiveRow ? 1 : 0)
                + (showEnergyChart ? 1 : 0)
                + (hasStandaloneSocSection ? 1 : 0)
                + 1 // bill
                + 1; // footer
            const gapHeight = Math.max(0, renderedSections - 1) * estimatedGap;
            let billAvailableHeight = trmnlHeight - nonBillSectionsHeight - gapHeight;

            const billHeaderAndTotal = compactBillMode ? 56 : 64;
            const billRowHeight = compactBillMode ? 24 : 28;
            const minBillHeight = billHeaderAndTotal + billRowHeight;
            const energyChartFloor = 110;
            const socChartFloor = 72;

            if (billAvailableHeight < minBillHeight && showEnergyChart) {
                const reducibleEnergy = Math.max(0, chartMinHeight - energyChartFloor);
                const needed = minBillHeight - billAvailableHeight;
                const cut = Math.min(reducibleEnergy, needed);
                chartMinHeight -= cut;
                billAvailableHeight += cut;
            }

            if (billAvailableHeight < minBillHeight && hasStandaloneSocChart) {
                const reducibleSoc = Math.max(0, socChartMinHeight - socChartFloor);
                const needed = minBillHeight - billAvailableHeight;
                const cut = Math.min(reducibleSoc, needed);
                socChartMinHeight -= cut;
                billAvailableHeight += cut;
            }

            const rowsByHeight = Math.floor((billAvailableHeight - billHeaderAndTotal) / billRowHeight);
            billRowsTarget = Math.max(1, Math.min(3, rowsByHeight));

            // In very-dense layouts (live + energy + SoC + bill), 3 rows often clips the total line.
            // Cap rows so the bill footer/total reliably stays visible on-device.
            if (isVeryDenseLayout) {
                billRowsTarget = Math.min(billRowsTarget, 2);
            }
            // Glyph SoC rows are short and easy to clip in the densest layout,
            // so prefer a compact bill to keep the SoC strip visible.
            if (isVeryDenseLayout && hasStandaloneSocGlyph) {
                billRowsTarget = Math.min(billRowsTarget, 1);
            }
            if (isLiveEnergyBillLayout) {
                billRowsTarget = Math.min(billRowsTarget, 2);
            }
        }
        const billCompactLevel = billRowsTarget <= 1 ? 2 : (billRowsTarget === 2 ? 1 : 0);

        const tariffTables = ctx.tariffGroups.map(group => {
            const periods = [...group.periods].sort((a, b) => {
                const aIsCurrent = Boolean(ctx.currentTouName && a.touName === ctx.currentTouName);
                const bIsCurrent = Boolean(ctx.currentTouName && b.touName === ctx.currentTouName);
                if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
                return a.touName.localeCompare(b.touName);
            });
            const displayedPeriods = periods.slice(0, Math.min(billRowsTarget, periods.length));
            const spanClass = billCompactLevel > 0 ? 'value--xsmall' : 'value--small';
            const totalClass = billCompactLevel > 0 ? 'title title--small' : 'title title--medium';

            return `
                    <table class="table w--full">
                        <thead>
                            <tr>
                                <th>Period</th>
                                <th>Home</th>
                                <th>Solar</th>
                                <th>Grid</th>
                                <th>Batt</th>
                                <th>Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${displayedPeriods.map(p => {
                const isCurrent = ctx.currentTouName && p.touName === ctx.currentTouName;
                const labelPrefix = isCurrent ? '> ' : '';
                const periodCostDisplay = p.cost < 0
                    ? `+${ctx.currency}${Math.abs(p.cost).toFixed(2)}`
                    : `${ctx.currency}${p.cost.toFixed(2)}`;

                return `
                                    <tr>
                                        <td><span class="${spanClass}">${labelPrefix}${p.label}</span></td>
                                        <td><span class="${spanClass}">${Math.round(wattsToKilowatts(p.home))}</span></td>
                                        <td><span class="${spanClass}">${Math.round(wattsToKilowatts(p.solar))}</span></td>
                                        <td><span class="${spanClass}">${Math.round(wattsToKilowatts(p.grid))}</span></td>
                                        <td><span class="${spanClass}">${Math.round(wattsToKilowatts(p.battery))}</span></td>
                                        <td><span class="${spanClass}">${periodCostDisplay}</span></td>
                                    </tr>
                                `;
            }).join('')}
                            <tr>
                                <td class="table-col">
                                    <span class="${totalClass}"><strong>${ctx.costLabel}</strong></span>
                                </td>
                                <td colspan="4"></td>
                                <td class="table-col">
                                    <span class="${totalClass}"><strong>${ctx.displayCost}</strong></span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
            `;
        }).join('');

        const renderGridIcon = (size: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 12 24" width="${size}" height="${size}"><path d="M7 2v11h3v9l7-12h-4l4-8z" fill="black"/></svg>`;
        const renderSunIcon = (size: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" fill="black" stroke="none"/><line x1="12" y1="1" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" /></svg>`;

        const showBillMetaHeader = !(isVeryDenseLayout || isLiveEnergyBillLayout);
        const showSiteNameInLiveRow = hasLiveRow && showEstimatedBill && !showBillMetaHeader;

        const liveStatsSection = hasLiveRow ? `
            <div class="w--full" style="position: relative; height: ${liveRowHeight}px; min-height: ${liveRowHeight}px;">
                ${showSiteNameInLiveRow ? `
                <span class="label label--small" style="position: absolute; top: 2px; left: 2px; line-height: 1; z-index: 2;">${ctx.siteName}</span>
                ` : ''}
                <div class="flex flex--row flex--center-y flex--center-x ${liveGap}" style="height: 100%;">
                    ${showLiveGridStat ? `
                    <div class="flex flex--row flex--center-y flex--center-x gap--small">
                        <span class="title title--xxlarge" style="font-size: ${liveValueFontPx}px; line-height: 1;">${(ctx.todayGrid as number).toFixed(1)}</span>
                        ${renderGridIcon(liveIconSize)}
                    </div>
                    ` : ''}

                    ${showLiveSolarStat ? `
                    <div class="flex flex--row flex--center-y flex--center-x gap--small">
                        <span class="title title--xxlarge" style="font-size: ${liveValueFontPx}px; line-height: 1;">${(ctx.todaySolar as number).toFixed(1)}</span>
                        ${renderSunIcon(liveIconSize)}
                    </div>
                    ` : ''}

                    ${showLiveBatteryStat ? `
                    <div class="flex flex--col flex--center-x">
                        ${this.renderBatteryStatusLarge(ctx.batterySoc, ctx.batteryStatus, { scale: liveBatteryScale })}
                    </div>
                    ` : ''}
                </div>
            </div>
        ` : '';

        const chartSection = showEnergyChart ? `
            <div class="flex flex--row flex--center-y flex--center-x w--full" style="flex: 1 1 auto; height: ${chartMinHeight}px; min-height: ${chartMinHeight}px;">
                ${ctx.seriesData ? this.renderChart(ctx.seriesData, {
            chartHeight: chartMinHeight,
            denseLegend: isDenseLayout || isVeryDenseLayout,
            veryDenseLegend: isVeryDenseLayout
        }) : ''}
            </div>
        ` : '';

        const standaloneSocSection = hasStandaloneSocChart ? `
            <div class="flex flex--row flex--center-x w--full" style="flex: 1 1 auto; height: ${socChartMinHeight}px; min-height: ${socChartMinHeight}px; align-items: stretch;">
                ${ctx.seriesData ? this.renderSocChart(ctx.seriesData, ctx.batterySoc, socChartMinHeight, {
            showXAxis: !showEnergyChart
        }) : '<span class="label">Battery SoC unavailable</span>'}
            </div>
        ` : (hasStandaloneSocGlyph ? `
            <div class="flex flex--row flex--center-x w--full" style="height: ${socGlyphSectionHeight}px; min-height: ${socGlyphSectionHeight}px; align-items: center;">
                <div class="flex flex--col w--full">
                    ${ctx.seriesData
                ? this.renderBatterySocGlyphStrip(ctx.seriesData, ctx.batterySoc, { showXAxis: !showEnergyChart })
                : this.renderBatterySocStandalone(ctx.batterySoc)}
                </div>
            </div>
        ` : '');

        const billSection = showEstimatedBill ? `
            <div class="flex flex--col w--full">
                ${showBillMetaHeader ? `
                <div class="flex flex--row flex--center-y w--full" style="justify-content: space-between; margin-bottom: 4px;">
                    <span class="title title--small" style="font-size: ${compactBillMode ? 15 : 17}px; line-height: 1;">${ctx.siteName}</span>
                    <span class="label label--small" style="font-size: ${compactBillMode ? 11 : 13}px; line-height: 1;">${ctx.dateRange}</span>
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
                         <span class="title title--small">${ctx.siteName}</span>
                         <span class="label label--small">${ctx.dateRange}</span>
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
        return `
            <div class="view view--half-vertical">
                 <div class="layout layout--col" style="padding: 10px; height: 100%;">
                    
                    <div class="flex flex--row flex--center-y" style="justify-content: space-between; width: 100%; margin-bottom: 10px;">
                         <span class="title title--small">${ctx.siteName}</span>
                         ${this.renderBatteryStatus(ctx.batterySoc, ctx.batteryStatus)}
                    </div>

                    <div class="flex flex--col flex--center-x" style="flex-grow: 1;">
                         <span class="label">${ctx.costLabel}</span>
                         <span class="title title--medium">${ctx.displayCost}</span>
                    </div>

                    <div class="flex flex--row" style="gap: 10px; width: 100%; margin-top: auto;">
                        <div class="flex flex--col flex--center-x" style="flex: 1;">
                            <span class="label">Grid</span>
                            <span class="value">${this.sumStat(ctx.tariffGroups, 'grid')}</span>
                        </div>
                         <div class="flex flex--col flex--center-x" style="flex: 1;">
                            <span class="label">Solar</span>
                            <span class="value">${this.sumStat(ctx.tariffGroups, 'solar')}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    static renderHalfHorizontal(ctx: RenderContext): string {
        return `
            <div class="view view--half-horizontal">
                <div class="layout layout--col" style="padding: 15px; height: 100%;">
                    <div class="flex flex--row flex--center-y" style="justify-content: space-between; width: 100%;">
                        <div class="flex flex--col">
                            <span class="title title--small">${ctx.siteName}</span>
                            <span class="label">${ctx.dateRange}</span>
                        </div>
                        <div class="flex flex--col" style="text-align: right; align-items: flex-end;">
                             <span class="label">${ctx.costLabel}</span>
                             <span class="title title--medium">${ctx.displayCost}</span>
                        </div>
                    </div>

                    <div class="flex flex--row flex--center-y" style="justify-content: space-between; width: 100%; margin-top: auto;">
                          ${this.renderHorizontalStat('Home', this.sumStat(ctx.tariffGroups, 'home'))}
                          ${this.renderHorizontalStat('Solar', this.sumStat(ctx.tariffGroups, 'solar'))}
                          ${this.renderHorizontalStat('Grid', this.sumStat(ctx.tariffGroups, 'grid'))}
                          <div style="margin-left: 10px;">
                             ${this.renderBatteryStatus(ctx.batterySoc, ctx.batteryStatus)}
                          </div>
                    </div>
                </div>
            </div>
        `;
    }

    static renderQuadrant(ctx: RenderContext): string {
        return `
            <div class="view view--quadrant">
                <div class="layout layout--col layout--center" style="padding: 10px; width: 100%; height: 100%;">
                    <span class="label mb-2">${ctx.costLabel}</span>
                    <span class="title title--medium">${ctx.displayCost}</span>
                </div>
            </div>
        `;
    }

    private static sumStat(groups: TariffGroup[], field: 'home' | 'grid' | 'solar' | 'battery'): string {
        let total = 0;
        groups.forEach(g => g.periods.forEach(p => total += p[field]));
        return wattsToKilowatts(total).toFixed(1) + ' kWh';
    }

    private static renderHorizontalStat(label: string, value: string): string {
        return `
            <div class="flex flex--col">
                <span class="label">${label}</span>
                <span class="value value--small">${value}</span>
            </div>
        `;
    }

    private static renderBatteryStatus(soc?: number | null, status?: 'charging' | 'discharging' | 'idle'): string {
        const hasData = soc !== undefined && soc !== null;
        const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;
        const text = hasData ? Math.round(level).toString() : '--';

        let icon = '';
        if (status === 'charging') icon = TrmnlRenderer.CHARGING_ICON;
        if (status === 'discharging') icon = TrmnlRenderer.DISCHARGING_ICON;

        // Interactive Battery SVG
        // Width 24px, Height 14px
        // Inner Fill: Max width ~20px (leaving padding)
        const fillWidth = (level / 100) * 18;

        const batterySvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="52" height="28" viewBox="0 0 26 14">
                <rect x="0.5" y="0.5" width="22" height="13" rx="2" fill="none" stroke="black" stroke-width="1.5" />
                <path d="M23 4h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1 -1.5 1.5H23V4z" fill="black" />
                <rect x="2.5" y="2.5" width="${fillWidth}" height="9" rx="0.5" fill="black" />
            </svg>
        `;

        return `
            <div class="flex flex--row flex--center-y gap--xsmall">
                <span class="value value--large">${text}</span>
                <span class="value value--xsmall">%</span>
                ${batterySvg}
                ${icon ? `<div>${icon}</div>` : ''}
            </div>
        `;
    }

    private static renderBatteryStatusLarge(
        soc?: number | null,
        status?: 'charging' | 'discharging' | 'idle',
        options?: { scale?: number }
    ): string {
        const hasData = soc !== undefined && soc !== null;
        const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;
        const text = hasData ? Math.round(level).toString() : '--';
        const scale = options?.scale ?? 1;

        // Use STANDARD icons (32px) here instead of LARGE (40px) to ensure visibility and fit
        let icon = '';
        if (status === 'charging') icon = TrmnlRenderer.CHARGING_ICON;
        if (status === 'discharging') icon = TrmnlRenderer.DISCHARGING_ICON;

        // Interactive Battery SVG Large
        // Adjusted to 60x30 to fit nicely with text
        const fillWidth = (level / 100) * 18;

        const batterySvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(96 * scale)}" height="${Math.round(48 * scale)}" viewBox="0 0 26 14">
                <rect x="0.5" y="0.5" width="22" height="13" rx="2" fill="none" stroke="black" stroke-width="1.5" />
                <path d="M23 4h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1 -1.5 1.5H23V4z" fill="black" />
                <rect x="2.5" y="2.5" width="${fillWidth}" height="9" rx="0.5" fill="black" />
            </svg>
        `;

        return `
            <div class="flex flex--row flex--center-y gap--small">
                <div class="flex flex--row flex--center-y">
                     <span class="title title--xxlarge" style="font-size: ${Math.round(64 * scale)}px; line-height: 1;">${text}%</span>
                </div>
                <div class="flex flex--row flex--center-y gap--xsmall">
                    ${batterySvg}
                    ${icon ? `<div>${icon}</div>` : ''}
                </div>
            </div>
        `;
    }

    private static renderBatterySocStandalone(soc?: number | null): string {
        const hasData = soc !== undefined && soc !== null;
        const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;
        const text = hasData ? Math.round(level).toString() : '--';
        const fillWidth = (level / 100) * 18;

        const batterySvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="132" height="66" viewBox="0 0 26 14">
                <rect x="0.5" y="0.5" width="22" height="13" rx="2" fill="none" stroke="black" stroke-width="1.5" />
                <path d="M23 4h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1 -1.5 1.5H23V4z" fill="black" />
                <rect x="2.5" y="2.5" width="${fillWidth}" height="9" rx="0.5" fill="black" />
            </svg>
        `;

        return `
            <div class="flex flex--col flex--center-x">
                <div class="flex flex--row flex--center-y gap--small">
                    <span class="title title--xxlarge" style="font-size: 84px; line-height: 1;">${text}%</span>
                    ${batterySvg}
                </div>
            </div>
        `;
    }

    private static renderBatterySocGlyphStrip(
        data: EnergyData[],
        latestBatterySoc?: number | null,
        options?: { showXAxis?: boolean }
    ): string {
        const width = 760;
        const padding = { right: 10, left: 30 };
        const chartWidth = width - padding.left - padding.right;
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
        const startTime = data.length > 0 ? data[0].timestamp.getTime() : Date.now() - 24 * 60 * 60 * 1000;
        const endTime = data.length > 1 ? data[data.length - 1].timestamp.getTime() : Date.now();
        const duration = Math.max(1, endTime - startTime);
        const getX = (ts: number) => padding.left + ((ts - startTime) / duration) * chartWidth;
        const knownSoc = data
            .map((row): SocSample | null => (
                typeof row.battery_soc === 'number'
                    ? { timestamp: row.timestamp.getTime(), soc: row.battery_soc }
                    : null
            ))
            .filter((row): row is SocSample => row !== null)
            .sort((a, b) => a.timestamp - b.timestamp);

        const checkpoints = buildSocCheckpoints({
            samples: knownSoc,
            startTime,
            endTime,
            baseAnchorMs: 4 * 60 * 60 * 1000,
            rapidAnchorMs: 2 * 60 * 60 * 1000,
            deltaThreshold: 20,
            rapidSegmentDeltaThreshold: 20
        });

        const points = checkpoints.slice(0, 3);
        if (points.length === 0 && typeof latestBatterySoc !== 'number') {
            return `
                <div class="flex flex--row flex--center-x flex--center-y w--full" style="height: 100%;">
                    <span class="label label--small">Battery SoC unavailable</span>
                </div>
            `;
        }
        const fallbackPoint = typeof latestBatterySoc === 'number'
            ? [{ timestamp: endTime, soc: latestBatterySoc, delta: null as number | null }]
            : [];
        const renderPoints = points.length > 0 ? points : fallbackPoint;
        const showXAxis = Boolean(options?.showXAxis);
        const rowHeight = showXAxis ? 40 : 20;
        const axisY = 24;

        const renderGlyph = (timestamp: number, soc: number, delta: number | null): string => {
            const clampedSoc = clamp(soc, 0, 100);
            const fillWidth = 13.5 * (clampedSoc / 100);
            const marker = delta === null ? '' : (delta >= 0 ? '▲' : '▼');
            const safeX = clamp(getX(timestamp), padding.left + 30, width - padding.right - 20);
            return `
                <g transform="translate(${safeX}, 0)">
                    <text x="-12" y="9" font-family="${this.CHART_FONT_FAMILY}" font-size="10" text-anchor="end">${Math.round(clampedSoc)}%</text>
                    <rect x="-9" y="1" width="16" height="10" rx="1.6" fill="none" stroke="black" stroke-width="1.2"/>
                    <rect x="7" y="3.8" width="2.6" height="4.4" rx="0.7" fill="black"/>
                    <rect x="-7.2" y="2.6" width="${fillWidth}" height="6.8" rx="0.7" fill="black"/>
                    <text x="12" y="9" font-family="${this.CHART_FONT_FAMILY}" font-size="10" text-anchor="start">${marker}</text>
                </g>
            `;
        };

        const formatHour = (ts: number): string => {
            const d = new Date(ts);
            const h = d.getHours();
            const amPm = h < 12 ? 'am' : 'pm';
            let displayH = h % 12;
            if (displayH === 0) displayH = 12;
            return `${displayH}${amPm}`;
        };

        const hourLabels: string[] = [];
        if (showXAxis) {
            for (let h = 0; h <= 24; h += 6) {
                const labelTime = new Date(startTime);
                labelTime.setHours(h, 0, 0, 0);
                if (labelTime.getTime() >= startTime && labelTime.getTime() <= endTime) {
                    const x = getX(labelTime.getTime());
                    hourLabels.push(`<text x="${x}" y="${rowHeight - 2}" font-family="${this.CHART_FONT_FAMILY}" font-size="10" text-anchor="middle">${formatHour(labelTime.getTime())}</text>`);
                }
            }
        }

        return `
            <div style="width: 100%; min-width: 280px;">
                <svg viewBox="0 0 ${width} ${rowHeight}" width="100%" style="height: auto; display: block;" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
                    ${renderPoints.map((point) => renderGlyph(point.timestamp, point.soc, point.delta)).join('')}
                    ${showXAxis ? `<line x1="${padding.left}" y1="${axisY}" x2="${width - padding.right}" y2="${axisY}" stroke="#000" stroke-width="1" />` : ''}
                    ${hourLabels.join('')}
                </svg>
            </div>
        `;
    }

    // ... (keep renderHalfVertical/Horizontal/Quadrant same) ...

    private static buildHourLabelEntries(
        startTime: number,
        endTime: number,
        getX: (ts: number) => number,
        leftInset = 0
    ): { x: number; label: string; anchor: 'middle' | 'start' }[] {
        const entries: { x: number; label: string; anchor: 'middle' | 'start' }[] = [];
        for (let h = 0; h <= 24; h += 6) {
            const labelTime = new Date(startTime);
            labelTime.setHours(h, 0, 0, 0);
            if (labelTime.getTime() >= startTime && labelTime.getTime() <= endTime) {
                const x = getX(labelTime.getTime());
                const amPm = h % 24 < 12 ? 'am' : 'pm';
                let displayH = h % 12;
                if (displayH === 0) displayH = 12;
                entries.push({ x, label: `${displayH}${amPm}`, anchor: 'middle' });
            }
        }

        const hasMidnightLabel = entries.some((entry) => entry.label === '12am');
        if (!hasMidnightLabel && entries.length <= 2) {
            const midnightX = leftInset + 2;
            const minLabelSpacingPx = 28;
            return [
                { x: midnightX, label: '12am', anchor: 'start' },
                ...entries.filter((entry) => (entry.x - midnightX) >= minLabelSpacingPx)
            ];
        }

        return entries;
    }



    private static renderChart(
        data: EnergyData[],
        options: { chartHeight: number; denseLegend?: boolean; veryDenseLegend?: boolean }
    ): string {
        const start = Date.now();
        const width = 760;
        const height = Math.max(110, options.chartHeight);
        const denseLegend = Boolean(options.denseLegend);
        const veryDenseLegend = Boolean(options.veryDenseLegend);
        const bottomPadding = height <= 175 ? 28 : 36;
        const padding = { top: 8, right: 10, bottom: bottomPadding, left: 30 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        if (data.length < 2) return '';

        // Determine min/max time from data
        const startTime = data[0].timestamp.getTime();
        const endTime = data[data.length - 1].timestamp.getTime();
        const duration = Math.max(1, endTime - startTime);

        // Calculate scaling bounds (Convert 5-min Wh to average W)
        let maxValue = 1.0;
        let minValue = 0;
        data.forEach(d => {
            const home = energyToAveragePower(d.load_power);
            const solar = energyToAveragePower(d.solar_power);
            const battery = energyToAveragePower(d.battery_power);
            maxValue = Math.max(maxValue,
                home,
                solar,
                battery
            );
            minValue = Math.min(minValue, home, solar, battery);
        });
        const hasNegative = minValue < 0;
        const maxPositiveKw = Math.max(0.1, wattsToKilowatts(maxValue));
        const minNegativeKw = Math.min(0, wattsToKilowatts(minValue));
        const yMaxKw = Math.ceil((maxPositiveKw * 1.12) * 10) / 10;
        let yMinKw = 0;
        if (hasNegative) {
            // Keep negative headroom tight to observed discharge while avoiding extreme ranges.
            const negativeWithMargin = minNegativeKw * 1.15;
            const boundedNegative = Math.max(-5, negativeWithMargin);
            yMinKw = Math.floor(boundedNegative * 10) / 10;
            if (yMinKw === 0) yMinKw = -0.1;
        }
        const yRangeKw = Math.max(0.1, yMaxKw - yMinKw);

        const getX = (ts: number) => padding.left + ((ts - startTime) / duration) * chartWidth;
        const getY = (w: number) => {
            const kw = wattsToKilowatts(w);
            return padding.top + ((yMaxKw - kw) / yRangeKw) * chartHeight;
        };
        // Series paths (5-min intervals - convert Wh to Average W)
        const homePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(d.timestamp.getTime())} ${getY(energyToAveragePower(d.load_power))}`).join(' ');
        const solarPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(d.timestamp.getTime())} ${getY(energyToAveragePower(d.solar_power))}`).join(' ');
        const batteryPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(d.timestamp.getTime())} ${getY(energyToAveragePower(d.battery_power))}`).join(' ');

        // Grid lines (kW)
        const yTicks = hasNegative
            ? [yMinKw, 0, yMaxKw / 2, yMaxKw]
            : [0, yMaxKw / 2, yMaxKw];
        const gridLines = yTicks.map(v => {
            const y = getY(kilowattsToWatts(v)); // v is in kW, convert to Average W
            const stroke = v === 0 ? '#bbb' : '#eee';
            const strokeWidth = v === 0 ? '1.25' : '1';
            const yLabelX = padding.left + 2;
            return `<line x1="${padding.left}" y1="${y}" x2="${chartWidth + padding.left}" y2="${y}" stroke="${stroke}" stroke-width="${strokeWidth}" />
                    <text x="${yLabelX}" y="${y + 4}" font-family="${this.CHART_FONT_FAMILY}" font-size="13" font-weight="700" text-anchor="start">${v.toFixed(1)}</text>`;
        }).join('');

        // Time labels (Every 6 hours). Ensure 12am is visible early in the day.
        const renderHourLabels = this.buildHourLabelEntries(
            startTime,
            endTime,
            getX,
            padding.left
        );
        const hourLabelY = height - 6;
        const hourLabelLayer = renderHourLabels
            .map((entry) => {
                const anchor = entry.anchor === 'middle' ? 'middle' : 'start';
                return `<text x="${entry.x}" y="${hourLabelY}" font-family="${this.CHART_FONT_FAMILY}" font-size="12" font-weight="700" text-anchor="${anchor}">${entry.label}</text>`;
            })
            .join('');

        const legendTextSizePx = veryDenseLegend ? 10 : (denseLegend ? 11 : 12);
        const legendSampleWidthPx = veryDenseLegend ? 10 : (denseLegend ? 12 : 14);
        const legendGroupGapPx = veryDenseLegend ? 8 : (denseLegend ? 10 : 12);
        const legendItemGapPx = veryDenseLegend ? 3 : 4;
        const legendTopPx = veryDenseLegend ? 4 : 6;
        const legendPadding = veryDenseLegend ? '1px 4px' : (denseLegend ? '1px 5px' : '2px 6px');
        const legendOverlay = `
            <div class="flex flex--row" style="position: absolute; top: ${legendTopPx}px; right: 8px; z-index: 2; background: white; padding: ${legendPadding}; border-radius: 2px; gap: ${legendGroupGapPx}px;">
                <div class="flex flex--row flex--center-y" style="gap: ${legendItemGapPx}px;">
                    <span style="display:inline-block; width: ${legendSampleWidthPx}px; border-top: 3px solid black;"></span>
                    <span class="value value--xsmall" style="line-height: 1; font-size: ${legendTextSizePx}px;">Solar</span>
                </div>
                <div class="flex flex--row flex--center-y" style="gap: ${legendItemGapPx}px;">
                    <span style="display:inline-block; width: ${legendSampleWidthPx}px; border-top: 1px solid black;"></span>
                    <span class="value value--xsmall" style="line-height: 1; font-size: ${legendTextSizePx}px;">Home</span>
                </div>
                <div class="flex flex--row flex--center-y" style="gap: ${legendItemGapPx}px;">
                    <span style="display:inline-block; width: ${legendSampleWidthPx}px; border-top: 1px dashed black;"></span>
                    <span class="value value--xsmall" style="line-height: 1; font-size: ${legendTextSizePx}px;">Battery</span>
                </div>
            </div>
        `;

        const svg = `
            <div style="position: relative; width: 100%; height: 100%;">
            <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display: block;" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
                <!-- Background and Grid -->
                <rect width="${width}" height="${height}" fill="none" />
                ${gridLines}

                <!-- Series -->
                <path d="${solarPath}" fill="none" stroke="black" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                <path d="${homePath}" fill="none" stroke="black" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
                <path d="${batteryPath}" fill="none" stroke="black" stroke-width="1" stroke-dasharray="4,4" stroke-linecap="round" stroke-linejoin="round" />
                ${hourLabelLayer}
            </svg>
            ${legendOverlay}
            </div>
        `;
        const renderDuration = Date.now() - start;
        console.log(`[TrmnlRenderer] renderChart completed in ${renderDuration}ms`);
        return svg;
    }

    private static buildSocSeriesForChart(
        knownSoc: SocSample[],
        latestBatterySoc: number | null | undefined,
        startTime: number,
        endTime: number
    ): SocSample[] {
        if (knownSoc.length > 1) {
            return knownSoc;
        }

        if (knownSoc.length === 1) {
            const only = knownSoc[0];
            return [
                { timestamp: startTime, soc: only.soc },
                { timestamp: endTime, soc: only.soc }
            ];
        }

        if (typeof latestBatterySoc === 'number') {
            return [
                { timestamp: startTime, soc: latestBatterySoc },
                { timestamp: endTime, soc: latestBatterySoc }
            ];
        }

        return [];
    }

    private static buildSmoothedSocSeriesForChart(
        data: EnergyData[],
        latestBatterySoc: number | null | undefined,
        startTime: number,
        endTime: number
    ): SocSample[] {
        const baseRows = data
            .map((row) => ({
                timestamp: row.timestamp.getTime(),
                soc: typeof row.battery_soc === 'number' ? row.battery_soc : null as number | null
            }))
            .sort((a, b) => a.timestamp - b.timestamp);

        const knownSoc: SocSample[] = baseRows
            .filter((row): row is { timestamp: number; soc: number } => typeof row.soc === 'number')
            .map((row) => ({ timestamp: row.timestamp, soc: row.soc }));

        if (baseRows.length === 0) {
            return this.buildSocSeriesForChart(knownSoc, latestBatterySoc, startTime, endTime);
        }

        const knownIndexes: number[] = [];
        for (let i = 0; i < baseRows.length; i++) {
            if (typeof baseRows[i].soc === 'number') knownIndexes.push(i);
        }

        if (knownIndexes.length === 0) {
            if (typeof latestBatterySoc !== 'number') return [];
            return [
                { timestamp: startTime, soc: latestBatterySoc },
                { timestamp: endTime, soc: latestBatterySoc }
            ];
        }

        const firstKnown = knownIndexes[0];
        const lastKnown = knownIndexes[knownIndexes.length - 1];

        // Extend edges so the chart remains continuous over the full time range.
        for (let i = 0; i < firstKnown; i++) {
            baseRows[i].soc = baseRows[firstKnown].soc;
        }
        for (let i = lastKnown + 1; i < baseRows.length; i++) {
            baseRows[i].soc = baseRows[lastKnown].soc;
        }

        // Fill interior gaps by linear interpolation between known samples.
        for (let k = 0; k < knownIndexes.length - 1; k++) {
            const leftIdx = knownIndexes[k];
            const rightIdx = knownIndexes[k + 1];
            const leftSoc = baseRows[leftIdx].soc;
            const rightSoc = baseRows[rightIdx].soc;
            if (leftSoc === null || rightSoc === null) continue;

            const span = rightIdx - leftIdx;
            if (span <= 1) continue;

            for (let i = leftIdx + 1; i < rightIdx; i++) {
                const t = (i - leftIdx) / span;
                baseRows[i].soc = leftSoc + (rightSoc - leftSoc) * t;
            }
        }

        // Match desktop smoothing: light centered moving average.
        const windowRadius = 2;
        const smoothedValues = baseRows.map((_, i) => {
            let sum = 0;
            let count = 0;
            for (let j = i - windowRadius; j <= i + windowRadius; j++) {
                if (j < 0 || j >= baseRows.length) continue;
                const value = baseRows[j].soc;
                if (typeof value === 'number') {
                    sum += value;
                    count++;
                }
            }
            return count > 0 ? sum / count : null;
        });

        return baseRows
            .map((row, i): SocSample | null => {
                const soc = smoothedValues[i];
                return typeof soc === 'number'
                    ? { timestamp: row.timestamp, soc }
                    : null;
            })
            .filter((row): row is SocSample => row !== null);
    }

    private static renderSocChart(
        data: EnergyData[],
        latestBatterySoc?: number | null,
        chartHeight = 102,
        options?: { showXAxis?: boolean }
    ): string {
        const width = 760;
        const height = Math.max(92, chartHeight);
        const showXAxis = options?.showXAxis !== false;
        const bottomPadding = showXAxis
            ? (height < 96 ? 24 : 30)
            : 10;
        const padding = { top: 10, right: 26, bottom: bottomPadding, left: 24 };
        const chartWidth = width - padding.left - padding.right;
        const plotHeight = height - padding.top - padding.bottom;
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

        const startTime = data.length > 0 ? data[0].timestamp.getTime() : Date.now() - 24 * 60 * 60 * 1000;
        const endTime = data.length > 1 ? data[data.length - 1].timestamp.getTime() : Date.now();
        const duration = Math.max(1, endTime - startTime);
        const getX = (ts: number) => padding.left + ((ts - startTime) / duration) * chartWidth;
        const getSocY = (soc: number) => padding.top + plotHeight - (clamp(soc, 0, 100) / 100) * plotHeight;

        const socSeries = this.buildSmoothedSocSeriesForChart(data, latestBatterySoc, startTime, endTime);

        if (socSeries.length === 0) {
            return `<span class="label">Battery SoC unavailable</span>`;
        }

        const socPath = socSeries
            .map((point, i) => `${i === 0 ? 'M' : 'L'} ${getX(point.timestamp)} ${getSocY(point.soc)}`)
            .join(' ');

        const hourLabelEntries = this.buildHourLabelEntries(
            startTime,
            endTime,
            getX,
            padding.left
        );
        const xAxisLabelY = Math.min(height - 4, getSocY(0) + 14);
        const xAxisLabelLayer = showXAxis
            ? hourLabelEntries
                .map((entry) => {
                    const anchor = entry.anchor === 'middle' ? 'middle' : 'start';
                    return `<text x="${entry.x}" y="${xAxisLabelY}" font-family="${this.CHART_FONT_FAMILY}" font-size="12" font-weight="700" text-anchor="${anchor}">${entry.label}</text>`;
                })
                .join('')
            : '';

        return `
            <div style="position: relative; width: 100%; height: 100%; min-width: 280px;">
                <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display: block;" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
                    <line x1="${padding.left}" y1="${getSocY(100)}" x2="${width - padding.right}" y2="${getSocY(100)}" stroke="#eee" stroke-width="1" />
                    <line x1="${padding.left}" y1="${getSocY(50)}" x2="${width - padding.right}" y2="${getSocY(50)}" stroke="#eee" stroke-width="1" />
                    <line x1="${padding.left}" y1="${getSocY(0)}" x2="${width - padding.right}" y2="${getSocY(0)}" stroke="#eee" stroke-width="1" />
                    <path d="${socPath}" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    <text x="${padding.left}" y="${padding.top - 2}" font-family="${this.CHART_FONT_FAMILY}" font-size="12" font-weight="700" text-anchor="start">Battery Level (%)</text>
                    <text x="${width - 2}" y="${getSocY(100) + 4}" font-family="${this.CHART_FONT_FAMILY}" font-size="12" font-weight="700" text-anchor="end">100%</text>
                    <text x="${width - 2}" y="${getSocY(50) + 4}" font-family="${this.CHART_FONT_FAMILY}" font-size="12" font-weight="700" text-anchor="end">50%</text>
                    <text x="${width - 2}" y="${getSocY(0) + 4}" font-family="${this.CHART_FONT_FAMILY}" font-size="12" font-weight="700" text-anchor="end">0%</text>
                    ${xAxisLabelLayer}
                </svg>
            </div>
        `;
    }
}
