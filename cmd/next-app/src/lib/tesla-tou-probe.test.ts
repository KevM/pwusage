import { describe, expect, it } from 'vitest';
import type { TariffV2 } from './tesla-client';
import { buildPrecisionProbe, decimalPlaces, listRates } from './tesla-tou-probe';

const tariff = (): TariffV2 => ({
  code: 'X', name: 'Plan', utility: 'U',
  energy_charges: { Summer: { rates: { OFF_PEAK: 0.1, ON_PEAK: 0.3 } } },
  seasons: {},
  sell_tariff: { name: 'S', utility: 'U', energy_charges: { Summer: { rates: { OFF_PEAK: 0.03 } } }, seasons: {} },
});

describe('tesla TOU precision probe', () => {
  it('skips the unpriced ALL placeholder and zero rates', () => {
    const t = tariff();
    t.energy_charges = { ALL: { rates: { ALL: 0 } }, Summer: { rates: { OFF_PEAK: 0, ON_PEAK: 0.31 } } };
    const probe = buildPrecisionProbe(t);
    expect(probe?.target).toEqual({ group: 'Summer', period: 'ON_PEAK', before: 0.31, after: 0.31001 });
    expect(buildPrecisionProbe({ ...tariff(), energy_charges: { ALL: { rates: { ALL: 0 } } } })).toBeNull();
  });

  it('nudges exactly one buy rate by 0.00001 and leaves the original untouched', () => {
    const original = tariff();
    const probe = buildPrecisionProbe(original);
    expect(probe?.target).toEqual({ group: 'Summer', period: 'OFF_PEAK', before: 0.1, after: 0.10001 });
    expect(probe?.candidate.energy_charges.Summer.rates.OFF_PEAK).toBe(0.10001);
    expect(probe?.candidate.energy_charges.Summer.rates.ON_PEAK).toBe(0.3);
    expect(probe?.candidate.sell_tariff.energy_charges.Summer.rates.OFF_PEAK).toBe(0.03);
    expect(original.energy_charges.Summer.rates.OFF_PEAK).toBe(0.1);
  });

  it('counts decimals and lists every rate', () => {
    expect(decimalPlaces(0.10279)).toBe(5);
    expect(decimalPlaces(0.1)).toBe(1);
    expect(decimalPlaces(0.00001)).toBe(5);
    expect(listRates(tariff()).map(r => `${r.chargeKind}:${r.period}`)).toEqual([
      'buy:Summer/OFF_PEAK', 'buy:Summer/ON_PEAK', 'sell:Summer/OFF_PEAK',
    ]);
  });
});
