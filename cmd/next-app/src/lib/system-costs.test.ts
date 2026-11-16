import { describe, expect, it } from 'vitest';
import { mapSystemCostRows, parseSystemCostsInput } from './system-costs';
import { TariffValidationError } from './tariff-timeline';

const solar = { installDate: '2023-11-14', price: 24000, taxCreditPercent: 30, incentives: 1000 };
const powerwall = { installDate: '2024-03-04', price: 9000, taxCreditPercent: null, incentives: 0 };

describe('parseSystemCostsInput', () => {
  it('accepts a full solar and powerwall input', () => {
    expect(parseSystemCostsInput({ solar, powerwall })).toEqual({ solar, powerwall });
  });

  it('defaults incentives to 0 and the optional fields to null', () => {
    expect(parseSystemCostsInput({ solar: { price: 5000 }, powerwall: null })).toEqual({
      solar: { installDate: null, price: 5000, taxCreditPercent: null, incentives: 0 },
      powerwall: null,
    });
  });

  it('rejects incentives above price', () => {
    expect(() => parseSystemCostsInput({ solar: { ...solar, incentives: 25000 }, powerwall: null })).toThrow(TariffValidationError);
  });

  it('rejects a future install date', () => {
    expect(() => parseSystemCostsInput({ solar: { ...solar, installDate: '2999-01-01' }, powerwall: null })).toThrow(TariffValidationError);
  });

  it('rejects dates that do not exist', () => {
    expect(() => parseSystemCostsInput({ solar: { ...solar, installDate: '2023-02-30' }, powerwall: null })).toThrow(TariffValidationError);
  });

  it('rejects prices and tax credit percents out of range', () => {
    expect(() => parseSystemCostsInput({ solar: { ...solar, price: -1 }, powerwall: null })).toThrow(TariffValidationError);
    expect(() => parseSystemCostsInput({ solar: { ...solar, price: 1_000_001 }, powerwall: null })).toThrow(TariffValidationError);
    expect(() => parseSystemCostsInput({ solar: { ...solar, taxCreditPercent: 101 }, powerwall: null })).toThrow(TariffValidationError);
  });

  it('null component means delete', () => {
    expect(parseSystemCostsInput({ solar: null, powerwall: null })).toEqual({ solar: null, powerwall: null });
  });

  it('rejects a body that is not an object with both components', () => {
    expect(() => parseSystemCostsInput(null)).toThrow(TariffValidationError);
    expect(() => parseSystemCostsInput({ solar })).toThrow(TariffValidationError);
  });
});

describe('mapSystemCostRows', () => {
  it('maps numeric strings and leaves missing components null', () => {
    expect(mapSystemCostRows([
      { component: 'solar', install_date: '2023-11-14', price: '24000.00', tax_credit_percent: '30.00', incentives: '1000.00' },
    ])).toEqual({
      solar: { installDate: '2023-11-14', price: 24000, taxCreditPercent: 30, incentives: 1000 },
      powerwall: null,
    });
  });
});
