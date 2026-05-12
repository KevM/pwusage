import { describe, expect, it } from 'vitest';
import { getPeriodCardDisplay } from './period-card-display';

describe('getPeriodCardDisplay', () => {
    it('formats a sell card as Surplus with rounded kWh', () => {
        const d = getPeriodCardDisplay({
            cycleNetExportKwh: 290.4,
            marginalCost: 0.03,
            basis: 'sell',
            isActive: false
        });
        expect(d.costLabel).toBe('3¢ per kWh');
        expect(d.netLabel).toBe('Surplus 290 kWh');
        expect(d.colorClass).toContain('green');
        expect(d.ringClass).toBe('');
    });

    it('formats a buy card as Deficit with rounded kWh', () => {
        const d = getPeriodCardDisplay({
            cycleNetExportKwh: -95.2,
            marginalCost: 0.30,
            basis: 'buy',
            isActive: false
        });
        expect(d.costLabel).toBe('30¢ per kWh');
        expect(d.netLabel).toBe('Deficit 95 kWh');
        expect(d.colorClass).toContain('red');
    });

    it('formats a neutral card with em dashes for net, but shows cost if provided', () => {
        const d = getPeriodCardDisplay({
            cycleNetExportKwh: 0.05,
            marginalCost: 0.30,
            basis: 'neutral',
            isActive: false
        });
        expect(d.costLabel).toBe('30¢ per kWh');
        expect(d.netLabel).toBe('—');
        expect(d.colorClass).toContain('gray');
    });

    it('adds a highlight ring when active', () => {
        const d = getPeriodCardDisplay({
            cycleNetExportKwh: 290,
            marginalCost: 0.03,
            basis: 'sell',
            isActive: true
        });
        expect(d.ringClass).toContain('ring');
    });
});
