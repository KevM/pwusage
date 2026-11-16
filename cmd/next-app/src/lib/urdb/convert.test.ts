import { describe, expect, it } from 'vitest';
import { blendedTierRate, isFixedRate, urdbRateToSeasons } from './convert';
import type { UrdbRate } from './types';
import { validateTariffPlanInput } from '../tariff-timeline';
import weEnergiesEffective from './__fixtures__/we-energies-effective-2026-04-28.json';
import pgeDefaults from './__fixtures__/pge-defaults.json';
import weEnergiesDefaults from './__fixtures__/we-energies-defaults.json';
const all = (period: number) => Array.from({ length: 12 }, () => Array(24).fill(period) as number[]);
const fixed: UrdbRate = { label: 'fixed', name: 'Fixed', utility: 'Utility', energyweekdayschedule: all(0), energyweekendschedule: all(0), energyratestructure: [[{ rate: 0.2 }]], dgrules: 'Net Metering' };
const optionA = weEnergiesEffective.find(rate => rate.name.includes('Option A') && rate.name.includes('Single-Phase')) as UrdbRate;
const pgeE1 = pgeDefaults.find(rate => rate.energyratestructure?.some(tiers => tiers[0]?.rate === 0.32561)) as UrdbRate;
describe('URDB conversion', () => {
  it('blends daily tiers at monthly consumption', () => {
    expect(blendedTierRate([{ rate: 0.32561, max: 13.5, unit: 'kWh daily' }, { rate: 0.40702, max: 54, unit: 'kWh daily' }], 600)).toBeCloseTo((410.4 * 0.32561 + 189.6 * 0.40702) / 600);
  });
  it('falls back to the first tier without use', () => expect(blendedTierRate([{ rate: 0.2 }, { rate: 0.3 }], null)).toBe(0.2));
  it('detects fixed plans and converts net metering sell rates', () => {
    expect(isFixedRate(fixed)).toBe(true);
    const result = urdbRateToSeasons(fixed, { medianMonthlyKwh: null, fallbackSellRate: 0 });
    expect(result.ok && result.seasons[0].weekdayPeriods[0]).toMatchObject({ buyRate: 0.2, sellRate: 0.2, touName: 'OFF_PEAK' });
  });
  it('rejects unsupported tier units', () => {
    const rate = { ...fixed, energyratestructure: [[{ rate: 0.2, max: 10, unit: 'MW' }, { rate: 0.3 }]] };
    expect(urdbRateToSeasons(rate, { medianMonthlyKwh: 600, fallbackSellRate: 0 })).toEqual({ ok: false, reason: 'unsupported_tier_unit' });
  });
  it('converts We Energies Option A into on and off peak windows', () => {
    const result = urdbRateToSeasons(optionA, { medianMonthlyKwh: null, fallbackSellRate: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seasons).toHaveLength(1);
    expect(result.seasons[0]?.weekdayPeriods).toContainEqual(expect.objectContaining({
      touName: 'ON_PEAK', fromHour: 7, toHour: 19, buyRate: 0.27061,
    }));
    expect(result.seasons[0]?.weekendPeriods.every(period => period.touName === 'OFF_PEAK')).toBe(true);
  });
  it('flattens PG&E daily tiers at median monthly use and uses tier one without usage', () => {
    expect(blendedTierRate(pgeE1.energyratestructure?.[0] ?? [], 600)).toBeCloseTo(
      (410.4 * 0.32561 + 189.6 * 0.40702) / 600
    );
    expect(blendedTierRate(pgeE1.energyratestructure?.[0] ?? [], null)).toBe(0.32561);
  });
  it('uses buy rates for net metering and fallback sell rates for other export rules', () => {
    const netMetered = urdbRateToSeasons(fixed, { medianMonthlyKwh: null, fallbackSellRate: 0.07 });
    expect(netMetered.ok && netMetered.seasons[0]?.weekdayPeriods[0]?.sellRate).toBe(0.2);
    const other = { ...fixed, dgrules: 'Buy All Sell All' };
    const nonNetMetered = urdbRateToSeasons(other, { medianMonthlyKwh: null, fallbackSellRate: 0.07 });
    expect(nonNetMetered.ok && nonNetMetered.seasons[0]?.weekdayPeriods[0]?.sellRate).toBe(0.07);
  });
  it('detects fixed residential default plans and excludes the time-of-use plan', () => {
    const residentialDefault = weEnergiesDefaults.find(rate => rate.name.includes('Rg 1')) as UrdbRate;
    expect(isFixedRate(residentialDefault)).toBe(true);
    expect(isFixedRate(optionA)).toBe(false);
    expect(isFixedRate(pgeE1)).toBe(true);
  });
  it('produces a write input accepted by rate plan validation', () => {
    const result = urdbRateToSeasons(optionA, { medianMonthlyKwh: null, fallbackSellRate: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => validateTariffPlanInput({
      name: result.name, effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', seasons: result.seasons,
    }, '2026-01-01')).not.toThrow();
  });
});
