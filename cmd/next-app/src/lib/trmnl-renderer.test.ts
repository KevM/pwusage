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
                batterySocMode: 'glyph'
            }
        };

        const markup = TrmnlRenderer.renderFull(ctx);

        expect(markup).toContain('+$0.78');
        expect(markup).toContain('$0.50');
        expect(markup).not.toContain('$-0.78');
    });
});
