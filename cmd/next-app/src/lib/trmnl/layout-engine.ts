/**
 * Pure layout-budget calculator for the TRMNL full-screen view.
 *
 * This module contains the math that determines section heights,
 * density flags, and bill-row targets for a given RenderContext and
 * component configuration.  It is deliberately side-effect-free so
 * every code-path can be unit-tested without rendering HTML.
 */

import { RenderContext } from '../trmnl-renderer';
import { TrmnlComponentConfig, DEFAULT_TRMNL_COMPONENT_CONFIG } from '../trmnl-component-config';

/** TRMNL device viewport height in pixels. */
const TRMNL_HEIGHT = 480;
const FOOTER_HEIGHT = 24;
const ESTIMATED_GAP = 8;

export interface LayoutState {
    /* ---- visibility flags ---- */
    hasStandaloneSocChart: boolean;
    hasStandaloneSocGlyph: boolean;
    showLiveGridStat: boolean;
    showLiveSolarStat: boolean;
    showLiveBatteryStat: boolean;
    visibleLiveStatCount: number;
    hasLiveRow: boolean;
    hasStandaloneSocSection: boolean;
    showEnergyChart: boolean;
    showEstimatedBill: boolean;
    showBatterySoc: boolean;
    hasLoadTimingSection: boolean;

    /* ---- density classification ---- */
    activeSectionCount: number;
    isVeryDenseLayout: boolean;
    isDenseLayout: boolean;
    compactBillMode: boolean;
    isLiveEnergyBillLayout: boolean;

    /* ---- live-stats sizing ---- */
    liveDensityScale: number;
    liveIconSize: number;
    liveValueFontPx: number;
    liveGap: string;
    liveBatteryScale: number;
    liveRowHeight: number;

    /* ---- section heights ---- */
    chartMinHeight: number;
    socChartMinHeight: number;
    socGlyphSectionHeight: number;

    /* ---- bill sizing ---- */
    billRowsTarget: number;
    billCompactLevel: number;

    /* ---- load-timing sizing ---- */
    loadTimingMinHeight: number;
    loadTimingCompactLevel: number;

    /* ---- meta header ---- */
    showBillMetaHeader: boolean;
    showSiteNameInLiveRow: boolean;
}

export function calculateLayoutBudget(
    ctx: RenderContext,
    cfg?: TrmnlComponentConfig
): LayoutState {
    const config = cfg ?? ctx.componentConfig ?? DEFAULT_TRMNL_COMPONENT_CONFIG;

    const showLiveGrid = config.showLiveGrid;
    const showLiveSolar = config.showLiveSolar;
    const showLiveBattery = config.showLiveBattery;
    const showEnergyChart = config.showEnergyChart;
    const showBatterySoc = config.showBatterySoc;
    const showEstimatedBill = config.showEstimatedBill;
    const showLoadTiming = config.showLoadTiming;

    const hasStandaloneSocChart = showBatterySoc && config.batterySocMode === 'chart';
    const hasStandaloneSocGlyph = !hasStandaloneSocChart && showBatterySoc;
    const showLiveGridStat = showLiveGrid && ctx.todayGrid !== undefined;
    const showLiveSolarStat = showLiveSolar && ctx.todaySolar !== undefined;
    const showLiveBatteryStat = showLiveBattery;
    const visibleLiveStatCount = [showLiveGridStat, showLiveSolarStat, showLiveBatteryStat]
        .filter(Boolean)
        .length;
    const hasLiveRow = visibleLiveStatCount > 0;
    const hasStandaloneSocSection = hasStandaloneSocChart || hasStandaloneSocGlyph;
    const hasLoadTimingSection = showLoadTiming;
    const activeSectionCount = (hasLiveRow ? 1 : 0)
        + (showEnergyChart ? 1 : 0)
        + (hasStandaloneSocSection ? 1 : 0)
        + (showEstimatedBill ? 1 : 0)
        + (hasLoadTimingSection ? 1 : 0);
    const isVeryDenseLayout = activeSectionCount >= 4;
    const isDenseLayout = activeSectionCount === 3;
    const compactBillMode = showEstimatedBill && activeSectionCount >= 3;
    const isLiveEnergyBillLayout = showEstimatedBill && hasLiveRow && showEnergyChart && !hasStandaloneSocSection;
    const isLiveEnergyLoadTimingLayout = hasLoadTimingSection && hasLiveRow && showEnergyChart && !showEstimatedBill && !hasStandaloneSocSection;

    /* ---- live-stats sizing ---- */
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

    /* ---- chart heights ---- */
    // Load timing competes with the chart for vertical budget the same way
    // the bill does — its content (banner + period cells) doesn't compress
    // gracefully, so shrink the chart's floor when either is co-displayed.
    const chartHasFlexCompanion = showEstimatedBill || hasLoadTimingSection;
    let chartMinHeight = isVeryDenseLayout
        ? (hasStandaloneSocGlyph ? 138 : 128)
        : (chartHasFlexCompanion
            ? (hasLiveRow ? 160 : 210)
            : (hasStandaloneSocChart
                ? (hasLiveRow ? 176 : 230)
                : (hasLiveRow ? 250 : 310)));
    if (isLiveEnergyBillLayout) {
        chartMinHeight = 140;
    }
    if (isLiveEnergyLoadTimingLayout) {
        // Mirror the bill case: chart yields more height so Load timing's
        // multi-line cells (header + name + cost + net) have a comfortable
        // budget without clipping the active cell at the section bottom.
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
        const gapHeight = 8; // SoC chart + footer
        socChartMinHeight = Math.max(220, TRMNL_HEIGHT - FOOTER_HEIGHT - gapHeight);
    } else if (isLiveSocOnlyLayout) {
        // Fill remaining height when only live row + SoC chart + footer are visible.
        const gapHeight = 16; // live row + SoC chart + footer
        socChartMinHeight = Math.max(220, TRMNL_HEIGHT - liveRowHeight - FOOTER_HEIGHT - gapHeight);
    }
    const socGlyphSectionHeight = hasStandaloneSocGlyph ? (isVeryDenseLayout ? 28 : 24) : 0;

    // Load timing renders a flex grid of period cells. It is a flexible
    // section: when solo it fills the available height; co-displayed it gets a
    // compact floor and steps font/spacing down via loadTimingCompactLevel.
    const loadTimingCompactLevel = isVeryDenseLayout ? 2 : (isDenseLayout ? 1 : 0);
    const loadTimingMinHeight = !hasLoadTimingSection
        ? 0
        : (activeSectionCount <= 1
            ? Math.max(180, TRMNL_HEIGHT - FOOTER_HEIGHT - ESTIMATED_GAP)
            : (isVeryDenseLayout ? 96 : (isLiveEnergyLoadTimingLayout ? 168 : (isDenseLayout ? 156 : 168))));

    /* ---- bill sizing ---- */
    let billRowsTarget = 3;
    if (showEstimatedBill) {
        const liveSectionHeightEstimate = liveRowHeight;
        const nonBillSectionsHeight =
            liveSectionHeightEstimate +
            (showEnergyChart ? chartMinHeight : 0) +
            (hasStandaloneSocChart ? socChartMinHeight : socGlyphSectionHeight) +
            (hasLoadTimingSection ? loadTimingMinHeight : 0) +
            FOOTER_HEIGHT;
        const renderedSections = (hasLiveRow ? 1 : 0)
            + (showEnergyChart ? 1 : 0)
            + (hasStandaloneSocSection ? 1 : 0)
            + (hasLoadTimingSection ? 1 : 0)
            + 1 // bill
            + 1; // footer
        const gapHeight = Math.max(0, renderedSections - 1) * ESTIMATED_GAP;
        let billAvailableHeight = TRMNL_HEIGHT - nonBillSectionsHeight - gapHeight;

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

    /* ---- meta header ---- */
    const showBillMetaHeader = !(isVeryDenseLayout || isLiveEnergyBillLayout);
    const showSiteNameInLiveRow = hasLiveRow && showEstimatedBill && !showBillMetaHeader;

    return {
        hasStandaloneSocChart,
        hasStandaloneSocGlyph,
        showLiveGridStat,
        showLiveSolarStat,
        showLiveBatteryStat,
        visibleLiveStatCount,
        hasLiveRow,
        hasStandaloneSocSection,
        showEnergyChart,
        showEstimatedBill,
        showBatterySoc,
        hasLoadTimingSection,

        activeSectionCount,
        isVeryDenseLayout,
        isDenseLayout,
        compactBillMode,
        isLiveEnergyBillLayout,

        liveDensityScale,
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

        loadTimingMinHeight,
        loadTimingCompactLevel,

        showBillMetaHeader,
        showSiteNameInLiveRow
    };
}
