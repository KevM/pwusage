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
    });
});
