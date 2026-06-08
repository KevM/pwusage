import { describe, expect, it } from 'vitest';
import { TrmnlRenderer, RenderContext } from './trmnl-renderer';

describe('TrmnlRenderer bill formatting', () => {
    it('renders negative period costs as credits in the bill table', () => {
        const ctx: RenderContext = {
            siteName: 'Harrison',
            dateRange: '2/11 - 3/11',
            tariffGroups: [
                {
                    tariffId: 1,
                    tariffName: 'Default Tariff',
                    periods: [
                        {
                            touName: 'on_peak',
                            label: 'On-Peak',
                            home: 69000,
                            grid: -19000,
                            solar: 85000,
                            battery: -3000,
                            cost: -0.78
                        },
                        {
                            touName: 'off_peak',
                            label: 'Off-Peak',
                            home: 56000,
                            grid: -2000,
                            solar: 58000,
                            battery: 0,
                            cost: 0.50
                        }
                    ]
                }
            ],
            totalCost: 10.29,
            currency: '$',
            displayCost: '$10.29',
            costLabel: 'Total Cost',
            componentConfig: {
                showLiveGrid: false,
                showLiveSolar: false,
                showLiveBattery: false,
                showEnergyChart: false,
                showBatterySoc: false,
                showEstimatedBill: true,
                batterySocMode: 'glyph',
                showLoadTiming: false,
                showEnergyFlow: false,
                flowBasis: 'cumulative'
            }
        };

        const markup = TrmnlRenderer.renderFull(ctx);

        expect(markup).toContain('+$0.78');
        expect(markup).toContain('$0.50');
        expect(markup).not.toContain('$-0.78');
    });

    it('renders half-horizontal home, solar, and grid stats from daily totals when provided', () => {
        const ctx: RenderContext = {
            siteName: 'Harrison',
            dateRange: '4/1 - 5/1',
            tariffGroups: [
                {
                    tariffId: 1,
                    tariffName: 'Default Tariff',
                    periods: [
                        {
                            touName: 'all_day',
                            label: 'All-Day',
                            home: 69800,
                            grid: 64000,
                            solar: 0,
                            battery: 0,
                            cost: 9.12
                        }
                    ]
                }
            ],
            totalCost: 9.12,
            currency: '$',
            displayCost: '$9.12',
            costLabel: 'Total Cost',
            todayHome: 6.1,
            todaySolar: 0,
            todayGrid: 6.1,
            componentConfig: {
                showLiveGrid: true,
                showLiveSolar: true,
                showLiveBattery: false,
                showEnergyChart: false,
                showBatterySoc: false,
                showEstimatedBill: true,
                batterySocMode: 'glyph',
                showLoadTiming: false,
                showEnergyFlow: false,
                flowBasis: 'cumulative'
            }
        };

        const markup = TrmnlRenderer.renderHalfHorizontal(ctx);

        expect(markup).toContain('6.1 kWh');
        expect(markup).toContain('0.0 kWh');
        expect(markup).not.toContain('69.8 kWh');
        expect(markup).not.toContain('64.0 kWh');
    });
});
