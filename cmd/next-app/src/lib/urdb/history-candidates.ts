import type { Tariff } from '../db-types';
import type { RatePlanHistoryPlan, RatePlanHistoryResponse, RatePlanKind, RatePlanPeakWindow, TariffSeasonInput } from '../tariff-contract';
import { urdbRateToSeasons } from './convert';
import type { UrdbApi } from './estimate-job';
import type { HistoryWindow } from './history-window';
import { askDate } from './history-window';
import { buyRateDistance, planKind, teslaShape, urdbStartDate } from './match';
import type { UrdbRate } from './types';

const MAX_CONCURRENT_URDB_CALLS = 4;
/** URDB is queried with sector=Residential already; this only drops the few non-home services filed there. */
const NOT_RESIDENTIAL = /\b(lighting|irrigation|industrial)\b/i;
const round5 = (value: number) => Math.round(value * 1e5) / 1e5;

export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index]); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const tidy = (name: string) => name.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\(\)/g, '').replace(/\s+/g, ' ').trim();
/** The plan name with its `Option <letter>` token (and the comma or parentheses left around it) removed. */
function withoutOption(name: string): string {
  return tidy(name.replace(/\(\s*Option [A-Za-z]\s*\)/g, '').replace(/,\s*Option [A-Za-z]\b/g, '').replace(/\bOption [A-Za-z]\b,?/g, ''));
}
/** The name shown to owners: no phase and no option (saved plans keep the full URDB name). */
export function displayPlanName(name: string): string {
  return tidy(withoutOption(name).replace(/\(\s*Single-Phase\s*\)/gi, '').replace(/,\s*Single-Phase\b/gi, '').replace(/\bSingle-Phase\b,?/gi, ''));
}

interface Item { rate: UrdbRate; name: string; kind: RatePlanKind; start: string; low: number; high: number; window: RatePlanPeakWindow | null; signature: string; distance: number | null }
const containsJuly = (season: TariffSeasonInput) => season.fromMonth <= season.toMonth ? season.fromMonth <= 7 && season.toMonth >= 7 : season.fromMonth <= 7 || season.toMonth >= 7;
function peakWindow(rate: UrdbRate, seasons: TariffSeasonInput[]): RatePlanPeakWindow | null {
  const season = seasons.find(containsJuly) ?? seasons[0];
  const windows = season?.weekdayPeriods ?? [];
  const peak = windows.find(window => window.touName === 'ON_PEAK') ?? [...windows].sort((a, b) => b.buyRate - a.buyRate)[0];
  return peak ? { label: rate.label, fromHour: peak.fromHour, toHour: peak.toHour } : null;
}
function toItem(rate: UrdbRate, tesla: Tariff | null): Item | null {
  const start = urdbStartDate(rate);
  if (!start || NOT_RESIDENTIAL.test(rate.name)) return null;
  const converted = urdbRateToSeasons(rate, { medianMonthlyKwh: null, fallbackSellRate: 0 });
  if (!converted.ok) return null;
  const kind = planKind(rate);
  const prices = converted.seasons.flatMap(season => [...season.weekdayPeriods, ...season.weekendPeriods].map(window => window.buyRate));
  const signature = JSON.stringify(converted.seasons.map(season => [season.fromMonth, season.toMonth, [...new Set([...season.weekdayPeriods, ...season.weekendPeriods].map(window => round5(window.buyRate)))].sort((a, b) => a - b)]));
  return {
    rate, name: withoutOption(rate.name), kind, start,
    low: prices.length ? Math.min(...prices) : 0, high: prices.length ? Math.max(...prices) : 0,
    window: kind === 'time_of_use' ? peakWindow(rate, converted.seasons) ?? { label: rate.label, fromHour: 0, toHour: 24 } : null,
    signature, distance: tesla ? buyRateDistance(tesla, rate) : null,
  };
}

/** Residential plans in effect on one date: unconvertible and three-phase twins dropped, Peak-hours options grouped, closest flagged. */
export function historyPlans(rates: UrdbRate[], tesla: Tariff | null, defaults: Set<string>): RatePlanHistoryPlan[] {
  const names = new Set(rates.map(rate => rate.name.toLowerCase()));
  const kept = rates.filter(rate => !(/three[- ]phase/i.test(rate.name) && names.has(rate.name.replace(/three([- ])phase/i, 'Single$1Phase').toLowerCase())));
  const items = kept.flatMap(rate => toItem(rate, tesla) ?? []);
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.kind === 'time_of_use' ? JSON.stringify([item.name, item.signature]) : item.rate.label;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const closestItem = items.filter(item => item.distance !== null)
    .sort((a, b) => (a.distance as number) - (b.distance as number) || a.name.localeCompare(b.name) || a.rate.label.localeCompare(b.rate.label))[0];
  return [...groups.values()].map((group): RatePlanHistoryPlan => {
    const first = group[0];
    const holdsClosest = closestItem !== undefined && group.includes(closestItem);
    return {
      name: first.name,
      startDate: group.map(item => item.start).sort().at(-1) as string,
      kind: first.kind,
      isDefault: group.some(item => defaults.has(item.rate.label)),
      closest: holdsClosest,
      lowRate: Math.min(...group.map(item => item.low)),
      highRate: Math.max(...group.map(item => item.high)),
      peakWindows: first.kind === 'time_of_use' ? group.flatMap(item => item.window ?? []).sort((a, b) => a.fromHour - b.fromHour || a.label.localeCompare(b.label)) : [],
      closestWindow: holdsClosest && first.kind === 'time_of_use' ? closestItem.window?.label ?? null : null,
      fixedLabel: first.kind === 'fixed' ? first.rate.label : null,
    };
  }).sort((a, b) => Number(b.closest) - Number(a.closest) || a.name.localeCompare(b.name));
}

export async function buildRatePlanHistory(input: { api: UrdbApi; utilityName: string; timeZone: string; today: string; window: HistoryWindow; tesla: Tariff | null }): Promise<RatePlanHistoryResponse> {
  const { api, utilityName, timeZone, today, window, tesla } = input;
  const dates = [today, ...window.askYears.map(year => askDate(year, window, today))];
  // One call per date plus the utility's defaults, at most four at a time.
  const tasks: Array<() => Promise<UrdbRate[]>> = [() => api.defaultRates(utilityName), ...dates.map(date => () => api.ratesEffectiveOn(utilityName, date, timeZone))];
  const [defaultList, ...lists] = await mapWithConcurrency(tasks, MAX_CONCURRENT_URDB_CALLS, task => task());
  const defaults = new Set(defaultList.filter(rate => rate.is_default).map(rate => rate.label));
  return {
    utilityName, historyStart: window.historyStart, fillThrough: window.fillThrough, teslaShape: teslaShape(tesla),
    current: historyPlans(lists[0], tesla, defaults),
    years: window.askYears.map((year, index) => ({ year, askDate: dates[index + 1], plans: historyPlans(lists[index + 1], tesla, defaults) })),
  };
}
