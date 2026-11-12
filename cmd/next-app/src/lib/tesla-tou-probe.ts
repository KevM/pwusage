import type { TariffV2 } from './tesla-client';

/** How many decimal places a rate carries (1e-5 steps and finer included). */
export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = value.toString();
  if (text.includes('e-')) return Number(text.split('e-')[1]) + (text.split('e-')[0].split('.')[1]?.length ?? 0);
  return text.split('.')[1]?.length ?? 0;
}

export interface RateRef {
  chargeKind: 'buy' | 'sell';
  period: string;
  value: number;
}

export function listRates(tariff: TariffV2): RateRef[] {
  const out: RateRef[] = [];
  for (const [period, charge] of Object.entries(tariff.energy_charges ?? {})) {
    for (const [name, value] of Object.entries(charge.rates ?? {})) {
      out.push({ chargeKind: 'buy', period: `${period}/${name}`, value });
    }
  }
  for (const [period, charge] of Object.entries(tariff.sell_tariff?.energy_charges ?? {})) {
    for (const [name, value] of Object.entries(charge.rates ?? {})) {
      out.push({ chargeKind: 'sell', period: `${period}/${name}`, value });
    }
  }
  return out;
}

export interface PrecisionProbe {
  candidate: TariffV2;
  /** Which rate was nudged, and from/to what. */
  target: { period: string; group: string; before: number; after: number };
}

/**
 * Copy of `tariff` with ONE buy rate raised by 0.00001 ($/kWh). Raising a buy rate cannot
 * trip Tesla's "buy below sell" adjustment, and a 1e-5 step is invisible to billing but
 * shows whether Tesla keeps five decimal places or rounds them away.
 */
export function buildPrecisionProbe(tariff: TariffV2): PrecisionProbe | null {
  const candidate = JSON.parse(JSON.stringify(tariff)) as TariffV2;
  for (const [group, charge] of Object.entries(candidate.energy_charges ?? {})) {
    for (const [period, value] of Object.entries(charge.rates ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const after = Math.round((value + 0.00001) * 1e5) / 1e5;
      if (after === value) continue;
      charge.rates[period] = after;
      return { candidate, target: { period, group, before: value, after } };
    }
  }
  return null;
}
