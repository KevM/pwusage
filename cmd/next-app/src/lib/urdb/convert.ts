import type { TariffPeriodName, TariffSeasonInput, TimePeriodWindowInput } from '../tariff-contract';
import type { UrdbRate, UrdbTier } from './types';
export interface ConvertContext { medianMonthlyKwh: number | null; fallbackSellRate: number }
export type ConvertResult = { ok: true; name: string; seasons: TariffSeasonInput[] } | { ok: false; reason: 'no_schedule' | 'too_many_seasons' | 'too_many_periods' | 'unsupported_tier_unit' };
const rounded = (n: number) => Math.round(n * 100_000) / 100_000;
const price = (tier: UrdbTier) => (tier.rate ?? 0) + (tier.adj ?? 0);
export function blendedTierRate(tiers: UrdbTier[], monthlyKwh: number | null): number | null {
  if (!tiers.length || tiers[0].rate === undefined) return null;
  if (monthlyKwh === null || monthlyKwh <= 0 || tiers.length === 1) return price(tiers[0]);
  let used = 0;
  let cost = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (tier.rate === undefined) return null;
    const factor = tier.unit === 'kWh daily' ? 30.4 : tier.unit === 'kWh' || tier.unit === undefined ? 1 : null;
    if (factor === null) return null;
    const ceiling = tier.max === undefined ? Infinity : tier.max * factor;
    const amount = Math.max(0, Math.min(monthlyKwh, ceiling) - used);
    cost += amount * price(tier);
    used += amount;
    if (used >= monthlyKwh) break;
    if (i === tiers.length - 1) { cost += (monthlyKwh - used) * price(tier); used = monthlyKwh; }
  }
  return cost / monthlyKwh;
}
export function urdbBuyRateAt(rate: UrdbRate, month: number, weekend: boolean, hour: number, withAdj: boolean): number | null {
  const index = (weekend ? rate.energyweekendschedule : rate.energyweekdayschedule)?.[month - 1]?.[hour];
  const tier = index === undefined ? undefined : rate.energyratestructure?.[index]?.[0];
  return tier?.rate === undefined ? null : tier.rate + (withAdj ? tier.adj ?? 0 : 0);
}
function validSchedule(rate: UrdbRate): boolean {
  return [rate.energyweekdayschedule, rate.energyweekendschedule].every(schedule => schedule?.length === 12 && schedule.every(row => row.length === 24 && row.every(index => Number.isInteger(index) && !!rate.energyratestructure?.[index]?.length)));
}
export function isFixedRate(rate: UrdbRate): boolean {
  if (!validSchedule(rate)) return false;
  return Array.from({ length: 12 }, (_, month) => {
    const weekday = rate.energyweekdayschedule?.[month] ?? [];
    const weekend = rate.energyweekendschedule?.[month] ?? [];
    return [...weekday, ...weekend].every(value => value === weekday[0]);
  }).every(Boolean);
}
export function urdbRateToSeasons(rate: UrdbRate, ctx: ConvertContext): ConvertResult {
  if (!validSchedule(rate)) return { ok: false, reason: 'no_schedule' };
  if ((rate.energyratestructure ?? []).some(tiers => tiers.length > 1 && tiers.some(tier => tier.unit !== undefined && tier.unit !== 'kWh' && tier.unit !== 'kWh daily'))) return { ok: false, reason: 'unsupported_tier_unit' };
  const prices = (rate.energyratestructure ?? []).map(tiers => blendedTierRate(tiers, ctx.medianMonthlyKwh));
  if (prices.some(value => value === null)) return { ok: false, reason: 'unsupported_tier_unit' };
  const weekdays = rate.energyweekdayschedule ?? [];
  const weekends = rate.energyweekendschedule ?? [];
  const key = (month: number) => JSON.stringify([weekdays[month], weekends[month]]);
  const starts = Array.from({ length: 12 }, (_, m) => m).filter(m => key(m) !== key((m + 11) % 12));
  if (!starts.length) starts.push(0);
  if (starts.length > 6) return { ok: false, reason: 'too_many_seasons' };
  const seasons: TariffSeasonInput[] = [];
  for (const start of starts) {
    let finish = start;
    while ((finish + 1) % 12 !== start && key((finish + 1) % 12) === key(start)) finish = (finish + 1) % 12;
    const indices = [...new Set([...weekdays[start], ...weekends[start]])];
    const distinct = [...new Set(indices.map(index => rounded(prices[index] as number)))].sort((a, b) => a - b);
    if (distinct.length > 4) return { ok: false, reason: 'too_many_periods' };
    const names: TariffPeriodName[] = distinct.length === 1 ? ['OFF_PEAK'] : distinct.length === 2 ? ['OFF_PEAK', 'ON_PEAK'] : distinct.length === 3 ? ['OFF_PEAK', 'PARTIAL_PEAK', 'ON_PEAK'] : ['SUPER_OFF_PEAK', 'OFF_PEAK', 'PARTIAL_PEAK', 'ON_PEAK'];
    const windows = (row: number[]): TimePeriodWindowInput[] => {
      const out: TimePeriodWindowInput[] = [];
      let from = 0;
      while (from < 24) {
        const index = row[from];
        const buyRate = rounded(prices[index] as number);
        const tier = rate.energyratestructure?.[index]?.[0];
        const sellRate = rounded(tier?.sell ?? (rate.dgrules === 'Net Metering' ? buyRate : ctx.fallbackSellRate));
        const name = names[distinct.indexOf(buyRate)];
        let to = from + 1;
        while (to < 24) {
          const next = row[to];
          const nextBuy = rounded(prices[next] as number);
          const nextTier = rate.energyratestructure?.[next]?.[0];
          const nextSell = rounded(nextTier?.sell ?? (rate.dgrules === 'Net Metering' ? nextBuy : ctx.fallbackSellRate));
          if (nextBuy !== buyRate || nextSell !== sellRate) break;
          to++;
        }
        out.push({ touName: name, fromHour: from, fromMinute: 0, toHour: to, toMinute: 0, buyRate, sellRate });
        from = to;
      }
      return out;
    };
    const containsJuly = start <= finish ? start <= 6 && finish >= 6 : start <= 6 || finish >= 6;
    seasons.push({ name: starts.length === 2 ? (containsJuly ? 'Summer' : 'Winter') : `Season ${seasons.length + 1}`, fromMonth: start + 1, toMonth: finish + 1, weekdayPeriods: windows(weekdays[start]), weekendPeriods: windows(weekends[start]) });
  }
  return { ok: true, name: rate.name.slice(0, 64), seasons };
}
