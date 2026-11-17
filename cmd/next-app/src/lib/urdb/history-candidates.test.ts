import { describe, expect, it, vi } from 'vitest';
import { buildRatePlanHistory, displayPlanName, historyPlans, mapWithConcurrency } from './history-candidates';
import { urdbRateToSeasons } from './convert';
import { compileSeasonsToParsedTariff } from '../tariff-timeline';
import type { Tariff } from '../db-types';
import type { UrdbRate } from './types';
import type { UrdbApi } from './estimate-job';
import type { HistoryWindow } from './history-window';
import y2023 from './__fixtures__/we-energies-effective-2023-11-14.json';
import y2024 from './__fixtures__/we-energies-effective-2024-07-01.json';
import y2025 from './__fixtures__/we-energies-effective-2025-07-01.json';
import y2026 from './__fixtures__/we-energies-effective-2026-11-16.json';
import weDefaults from './__fixtures__/we-energies-defaults.json';

const OPTION_B = '685a177d100bd6b82a005dc0';
const rates = (list: unknown) => list as UrdbRate[];
const adj = (rate: UrdbRate) => rate.energyratestructure?.flat().find(tier => tier.adj !== undefined)?.adj ?? 0;
function teslaFrom(rate: UrdbRate): Tariff {
  const converted = urdbRateToSeasons(rate, { medianMonthlyKwh: null, fallbackSellRate: 0 });
  if (!converted.ok) throw new Error('unconvertible');
  const parsed = compileSeasonsToParsedTariff(converted.name, converted.seasons);
  return { id: 1, site_id: 's', updated: new Date('2026-04-28T12:00:00Z'), name: rate.utility, plan_name: rate.name, plan_code: 'Rg 2', seasons: parsed.seasons as unknown as Tariff['seasons'] };
}
const harrisonTesla = () => teslaFrom(rates(y2025).find(rate => rate.label === OPTION_B) as UrdbRate);
const defaults = new Set(rates(weDefaults).filter(rate => rate.is_default).map(rate => rate.label));
const rg2 = (plans: ReturnType<typeof historyPlans>) => plans.find(plan => plan.name === 'Residential Time-of-Use (Single-Phase) Rg 2');

describe('historyPlans', () => {
  it('historyPlansDropsUnconvertibleAndThreePhaseTwins', () => {
    const broken = { ...rates(y2025)[1], label: 'broken', name: 'Broken', energyweekdayschedule: undefined };
    const names = historyPlans([...rates(y2025), broken], null, defaults).map(plan => plan.name);
    expect(names).not.toContain('Broken');
    expect(names.some(name => /three/i.test(name))).toBe(false);
  });
  it('dropsNonResidentialPlans', () => {
    const base = rates(y2025).find(rate => rate.label === '6859a625ee417fe3fa0cb0df') as UrdbRate;
    const named = (label: string, name: string) => ({ ...base, label, name, energyratestructure: base.energyratestructure?.map(tiers => tiers.map(tier => ({ ...tier, rate: (tier.rate ?? 0) + Number(label.length) / 100 }))) });
    const names = historyPlans([
      named('farm', 'Residential and Farm Service'),
      named('general', 'Residential General Service'),
      named('lights', 'Outdoor Lighting Service'),
      named('pumps', 'Irrigation Pumping'),
      named('plant', 'Industrial Power'),
    ], null, new Set()).map(plan => plan.name);
    expect(names).toEqual(expect.arrayContaining(['Residential and Farm Service', 'Residential General Service']));
    expect(names).not.toContain('Outdoor Lighting Service');
    expect(names).not.toContain('Irrigation Pumping');
    expect(names).not.toContain('Industrial Power');
  });
  it('historyPlansFlagsOnlyTheClosest', () => {
    const plans = historyPlans(rates(y2025), harrisonTesla(), defaults);
    expect(plans.filter(plan => plan.closest)).toHaveLength(1);
    expect(plans[0].closest).toBe(true);
  });
  it('groupsOptionsThatDifferOnlyInPeakHours', () => {
    const plans = historyPlans(rates(y2025), harrisonTesla(), defaults);
    expect(plans.map(plan => plan.name)).toEqual(['Residential Time-of-Use (Single-Phase) Rg 2', 'Farm (Single-Phase) Fg 1', 'Residential (Single-Phase) Rg 1']);
    const group = rg2(plans)!;
    expect(group.kind).toBe('time_of_use');
    expect(group.peakWindows.map(window => [window.fromHour, window.toHour])).toEqual([[7, 19], [8, 20], [9, 21], [10, 22]]);
    expect(group.closestWindow).toBe(OPTION_B);
    expect(group.closest).toBe(true);
    expect(group.fixedLabel).toBeNull();
  });
  it('differentPricesStayApart', () => {
    const base = rates(y2025).find(rate => rate.label === OPTION_B) as UrdbRate;
    const pricier = { ...base, label: 'pricier', name: base.name.replace('Option B', 'Option E'), energyratestructure: base.energyratestructure?.map(tiers => tiers.map(tier => ({ ...tier, rate: (tier.rate ?? 0) + 0.05 }))) };
    const plans = historyPlans([base, pricier], null, defaults);
    expect(plans).toHaveLength(2);
    expect(plans.every(plan => plan.peakWindows.length === 1)).toBe(true);
  });
  it('displayNamesDropPhaseAndOption', () => {
    expect(displayPlanName('Residential Time-of-Use (Single-Phase, Option B) Rg 2')).toBe('Residential Time-of-Use Rg 2');
    expect(displayPlanName('Residential (Single-Phase) Rg 1')).toBe('Residential Rg 1');
    expect(displayPlanName('Residential Time-of-Use (Single-Phase) Rg 2')).toBe('Residential Time-of-Use Rg 2');
  });
  it('noTeslaFlagsNoClosest', () => {
    const plans = historyPlans(rates(y2025), null, defaults);
    expect(plans.some(plan => plan.closest)).toBe(false);
    expect(plans.every(plan => plan.closestWindow === null)).toBe(true);
    expect(plans.map(plan => plan.name)).toEqual(['Farm (Single-Phase) Fg 1', 'Residential (Single-Phase) Rg 1', 'Residential Time-of-Use (Single-Phase) Rg 2']);
  });
  it('lowAndHighRatesFromConvertedSeasons', () => {
    const optionB = rates(y2025).find(rate => rate.label === OPTION_B) as UrdbRate;
    const group = rg2(historyPlans(rates(y2025), null, defaults))!;
    expect(group.lowRate).toBeCloseTo(0.10387 + adj(optionB), 5);
    expect(group.highRate).toBeCloseTo(0.27006 + adj(optionB), 5);
  });
  it('marksDefaultFixedPlansAndKeepsFixedLabel', () => {
    const fixed = historyPlans(rates(y2025), null, defaults).find(plan => plan.name === 'Residential (Single-Phase) Rg 1')!;
    expect(fixed.isDefault).toBe(true);
    expect(fixed.fixedLabel).toBe('6859a625ee417fe3fa0cb0df');
    expect(fixed.peakWindows).toEqual([]);
  });
});

const window: HistoryWindow = { historyStart: '2023-11-14', fillThrough: '2026-04-27', unconfirmedDays: 900, askYears: [2025, 2024, 2023] };
function fakeApi(delay = 0) {
  const byDate: Record<string, unknown> = { '2023-11-14': y2023, '2024-07-01': y2024, '2025-07-01': y2025, '2026-04-27': y2026, '2026-11-16': y2026 };
  let active = 0;
  let peak = 0;
  const call = async <T>(value: T): Promise<T> => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, delay)); active--; return value; };
  const ratesEffectiveOn = vi.fn((_utility: string, date: string) => call(rates(byDate[date] ?? [])));
  const defaultRates = vi.fn(() => call(rates(weDefaults)));
  return { api: { ratesEffectiveOn, defaultRates, rateByLabel: vi.fn(), utilityNames: vi.fn() } as unknown as UrdbApi, ratesEffectiveOn, defaultRates, peak: () => peak };
}
describe('buildRatePlanHistory', () => {
  it('buildsHarrisonYearsNewestFirst', async () => {
    const { api } = fakeApi();
    const result = await buildRatePlanHistory({ api, utilityName: 'Wisconsin Electric Power Co', timeZone: 'America/Chicago', today: '2026-11-16', window, tesla: harrisonTesla() });
    expect(result.years.map(year => [year.year, year.askDate])).toEqual([[2025, '2025-07-01'], [2024, '2024-07-01'], [2023, '2023-11-14']]);
    expect(result).toMatchObject({ utilityName: 'Wisconsin Electric Power Co', historyStart: '2023-11-14', fillThrough: '2026-04-27', teslaShape: 'time_of_use' });
    expect(result.current.length).toBe(3);
    expect(result.years[0].plans[0].closestWindow).toBe(OPTION_B);
  });
  it('currentListsThePlansInEffectWhereTheFillEnds', async () => {
    // The owner's answer covers the days up to the Tesla start, so a later switch must not leak in.
    const { api, ratesEffectiveOn } = fakeApi();
    await buildRatePlanHistory({ api, utilityName: 'U', timeZone: 'America/Chicago', today: '2026-11-16', window, tesla: harrisonTesla() });
    expect(ratesEffectiveOn.mock.calls.map(call => call[1])).toContain('2026-04-27');
    expect(ratesEffectiveOn.mock.calls.map(call => call[1])).not.toContain('2026-11-16');
    const open = fakeApi();
    await buildRatePlanHistory({ api: open.api, utilityName: 'U', timeZone: 'America/Chicago', today: '2026-11-16', window: { ...window, fillThrough: null }, tesla: null });
    expect(open.ratesEffectiveOn.mock.calls.map(call => call[1])).toContain('2026-11-16');
  });
  it('callsUrdbOncePerYearPlusTodayAndDefaults', async () => {
    const { api, ratesEffectiveOn, defaultRates } = fakeApi();
    await buildRatePlanHistory({ api, utilityName: 'U', timeZone: 'America/Chicago', today: '2026-11-16', window, tesla: null });
    expect(ratesEffectiveOn.mock.calls.length + defaultRates.mock.calls.length).toBe(5);
    expect(defaultRates).toHaveBeenCalledTimes(1);
  });
  it('limitsConcurrencyToFour', async () => {
    const fake = fakeApi(5);
    const wide: HistoryWindow = { ...window, askYears: [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018] };
    await buildRatePlanHistory({ api: fake.api, utilityName: 'U', timeZone: 'America/Chicago', today: '2026-11-16', window: wide, tesla: null });
    expect(fake.peak()).toBeLessThanOrEqual(4);
    expect(fake.peak()).toBeGreaterThan(1);
  });
  it('mapWithConcurrencyKeepsOrder', async () => {
    expect(await mapWithConcurrency([3, 1, 2], 2, async value => { await new Promise(resolve => setTimeout(resolve, value)); return value * 2; })).toEqual([6, 2, 4]);
  });
});
