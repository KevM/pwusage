import { describe, it, expect } from 'vitest';
import { calculateLayoutBudget } from './layout-engine';
import { RenderContext } from '../trmnl-renderer';
import { TrmnlComponentConfig } from '../trmnl-component-config';

/** Helper to build a minimal RenderContext for layout tests. */
function makeCtx(overrides?: Partial<RenderContext>): RenderContext {
    return {
        siteName: 'Test Site',
        dateRange: 'May 1 – May 2',
        tariffGroups: [],
        totalCost: 10,
        currency: '$',
        displayCost: '$10.00',
        costLabel: 'Est. Bill',
        ...overrides
    };
}

/** Helper to build a TrmnlComponentConfig. */
function makeCfg(overrides?: Partial<TrmnlComponentConfig>): TrmnlComponentConfig {
    return {
        showLiveGrid: false,
        showLiveSolar: false,
        showLiveBattery: false,
        showEnergyChart: false,
        showBatterySoc: false,
        showEstimatedBill: false,
        showLoadTiming: false,
        showEnergyFlow: false,
        flowBasis: 'cumulative',
        batterySocMode: 'glyph',
        ...overrides
    };
}

describe('Layout Engine', () => {
    describe('calculateLayoutBudget', () => {
        it('returns all-off state when no components are enabled', () => {
            const layout = calculateLayoutBudget(makeCtx(), makeCfg());
            expect(layout.hasLiveRow).toBe(false);
            expect(layout.isVeryDenseLayout).toBe(false);
            expect(layout.isDenseLayout).toBe(false);
        });

        it('enables live row when grid stat is visible', () => {
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5.2 }),
                makeCfg({ showLiveGrid: true })
            );
            expect(layout.hasLiveRow).toBe(true);
            expect(layout.visibleLiveStatCount).toBe(1);
        });

        it('calculates very dense layout when 4+ sections are active', () => {
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3, batterySoc: 80 }),
                makeCfg({
                    showLiveGrid: true,
                    showLiveSolar: true,
                    showLiveBattery: true,
                    showEnergyChart: true,
                    showBatterySoc: true,
                    showEstimatedBill: true,
                    batterySocMode: 'glyph'
                })
            );
            expect(layout.isVeryDenseLayout).toBe(true);
            expect(layout.billRowsTarget).toBeLessThanOrEqual(2);
        });

        it('calculates dense layout when 3 sections are active', () => {
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3 }),
                makeCfg({
                    showLiveGrid: true,
                    showLiveSolar: true,
                    showLiveBattery: true,
                    showEnergyChart: true,
                    showBatterySoc: false,
                    showEstimatedBill: true
                })
            );
            // live row + energy chart + bill = 3 sections
            expect(layout.isDenseLayout).toBe(true);
        });

        it('caps bill rows to 1 in very dense layout with SoC glyph', () => {
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3, batterySoc: 80 }),
                makeCfg({
                    showLiveGrid: true,
                    showLiveSolar: true,
                    showLiveBattery: true,
                    showEnergyChart: true,
                    showBatterySoc: true,
                    showEstimatedBill: true,
                    batterySocMode: 'glyph'
                })
            );
            expect(layout.billRowsTarget).toBeLessThanOrEqual(1);
        });

        it('calculates SoC-only layout when only SoC chart is enabled', () => {
            const layout = calculateLayoutBudget(
                makeCtx(),
                makeCfg({ showBatterySoc: true, batterySocMode: 'chart' })
            );
            expect(layout.socChartMinHeight).toBeGreaterThanOrEqual(220);
        });

        it('calculates live energy bill layout', () => {
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5 }),
                makeCfg({
                    showLiveGrid: true,
                    showEnergyChart: true,
                    showEstimatedBill: true,
                    showBatterySoc: false
                })
            );
            expect(layout.isLiveEnergyBillLayout).toBe(true);
            expect(layout.chartMinHeight).toBe(140);
        });

        it('returns correct bill compact level', () => {
            const layout = calculateLayoutBudget(makeCtx(), makeCfg());
            // With no bill, billRowsTarget defaults to 3, billCompactLevel = 0
            expect(layout.billCompactLevel).toBe(0);
        });

        it('counts load timing toward active sections', () => {
            const withLt = calculateLayoutBudget(makeCtx(), makeCfg({ showLoadTiming: true }));
            const withoutLt = calculateLayoutBudget(makeCtx(), makeCfg({ showLoadTiming: false }));
            expect(withLt.hasLoadTimingSection).toBe(true);
            expect(withLt.activeSectionCount).toBe(withoutLt.activeSectionCount + 1);
        });

        it('gives solo load timing a tall budget', () => {
            const layout = calculateLayoutBudget(makeCtx(), makeCfg({ showLoadTiming: true }));
            expect(layout.loadTimingMinHeight).toBeGreaterThanOrEqual(180);
        });

        it('shrinks chart floor and lifts load-timing budget when co-displayed (live+chart+loadTiming)', () => {
            // Mirrors the isLiveEnergyBillLayout override: live+chart+loadTiming
            // (no bill, no SoC) gives the chart a tighter 140 floor and Load
            // timing 168, so the 4-line active cell has room to breathe.
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5 }),
                makeCfg({ showLiveGrid: true, showEnergyChart: true, showLoadTiming: true })
            );
            expect(layout.chartMinHeight).toBe(140);
            expect(layout.loadTimingMinHeight).toBe(168);
        });

        it('compacts load timing in very dense layouts', () => {
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3, batterySoc: 80 }),
                makeCfg({
                    showLiveGrid: true, showLiveSolar: true, showLiveBattery: true,
                    showEnergyChart: true, showEstimatedBill: true, showLoadTiming: true
                })
            );
            expect(layout.loadTimingCompactLevel).toBe(2);
            expect(layout.loadTimingMinHeight).toBeLessThan(180);
        });

        it('includes load timing in bill height allocation math, reducing bill rows when load timing is enabled', () => {
            // Test with load timing disabled
            const layoutWithoutLt = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3, batterySoc: 80 }),
                makeCfg({
                    showLiveGrid: true,
                    showEnergyChart: true,
                    showEstimatedBill: true,
                    showBatterySoc: true,
                    batterySocMode: 'chart',
                    showLoadTiming: false
                })
            );

            // Test with load timing enabled
            const layoutWithLt = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3, batterySoc: 80 }),
                makeCfg({
                    showLiveGrid: true,
                    showEnergyChart: true,
                    showEstimatedBill: true,
                    showBatterySoc: true,
                    batterySocMode: 'chart',
                    showLoadTiming: true
                })
            );

            // In this dense layout, the available space for the bill should be smaller when load timing is enabled.
            // This should cause the bill rows target to be reduced to avoid canvas overflow.
            expect(layoutWithoutLt.billRowsTarget).toBe(2);
            expect(layoutWithLt.billRowsTarget).toBe(1);
        });

        it('flags a flow section and counts it toward density', () => {
            const soloFlow = calculateLayoutBudget(makeCtx(), makeCfg({ showEnergyFlow: true }));
            expect(soloFlow.hasFlowSection).toBe(true);
            expect(soloFlow.activeSectionCount).toBe(1);
            expect(soloFlow.flowMinHeight).toBeGreaterThan(300);

            const off = calculateLayoutBudget(makeCtx(), makeCfg());
            expect(off.hasFlowSection).toBe(false);
            expect(off.flowMinHeight).toBe(0);
        });

        it('shrinks the flow floor when co-displayed with other sections', () => {
            const solo = calculateLayoutBudget(makeCtx(), makeCfg({ showEnergyFlow: true }));
            const coDisplayed = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3 }),
                makeCfg({ showEnergyFlow: true, showLiveGrid: true, showLiveSolar: true, showLiveBattery: true, showEnergyChart: true })
            );
            expect(coDisplayed.flowMinHeight).toBeLessThan(solo.flowMinHeight);
            expect(coDisplayed.isDenseLayout || coDisplayed.isVeryDenseLayout).toBe(true);
        });

        it('reaches very-dense when flow joins live + chart + soc', () => {
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3, batterySoc: 80 }),
                makeCfg({
                    showEnergyFlow: true, showLiveGrid: true, showLiveSolar: true,
                    showLiveBattery: true, showEnergyChart: true,
                    showBatterySoc: true, batterySocMode: 'glyph'
                })
            );
            // live row + chart + SoC glyph + flow = 4 active sections.
            expect(layout.activeSectionCount).toBe(4);
            expect(layout.isVeryDenseLayout).toBe(true);
            expect(layout.flowMinHeight).toBe(150);
        });
    });
});
