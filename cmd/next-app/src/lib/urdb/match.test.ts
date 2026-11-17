import { describe, expect, it } from 'vitest';
import { anchorStart, buyRateDistance, estimateFreshness, estimateMayBeOutdated, newerRevision, pickTeslaMatch, planKind, referenceSpans, teslaMatchesUrdb, teslaShape, walkSupersedes } from './match';
import { compileSeasonsToParsedTariff } from '../tariff-timeline';
import type { TariffSeasonInput, TimePeriodWindowInput } from '../tariff-contract';
import { urdbRateToSeasons } from './convert';
import type { UrdbRate } from './types';
import type { Tariff } from '../db-types';
import weEnergiesEffective from './__fixtures__/we-energies-effective-2026-04-28.json';
import weEnergiesChain from './__fixtures__/we-energies-option-a-chain.json';
const rows = Array.from({ length: 12 }, () => Array(24).fill(0) as number[]);
const rate = (label: string, date: string, supersedes?: string): UrdbRate => ({ label, name: label, utility: 'U', startdate: Date.parse(`${date}T12:00:00Z`) / 1000, supersedes, energyratestructure: [[{ rate: 0.1 }]], energyweekdayschedule: rows, energyweekendschedule: rows });
describe('URDB revision history', () => {
  it('walks history oldest first and ignores end dates', async () => {
    const old = { ...rate('old', '2019-01-01'), enddate: 1 };
    const newer = rate('new', '2020-01-01', 'old');
    expect(await walkSupersedes(newer, async label => label === 'old' ? old : null, { endBefore: '2021-01-01', maxSteps: 80, timeZone: 'UTC' })).toEqual([
      { rate: old, effectiveFrom: '2019-01-01', effectiveTo: '2019-12-31' },
      { rate: newer, effectiveFrom: '2020-01-01', effectiveTo: '2020-12-31' },
    ]);
  });
  it('resolves duplicate reference starts by label', () => {
    expect(referenceSpans([rate('a', '2020-01-01'), rate('b', '2020-01-01')], 'UTC').map(span => span.rate.label)).toEqual(['b']);
  });
  it('keeps an earlier history start and does not move owner dated spans', () => {
    const input = { matched: null, firstSeen: '2026-04-28', isFirstVersion: true, currentSpanStart: '2023-11-14', ownerDated: false, timeZone: 'UTC' };
    expect(anchorStart(input)).toEqual({ startDate: '2023-11-14', startSource: 'history_start' });
    expect(anchorStart({ ...input, ownerDated: true })).toBeNull();
  });
  it('matches the recorded Tesla Option A schedule with the URDB adjustment', () => {
    const optionA = weEnergiesEffective.find(item => item.label === '6859a6a4417690873a01fd68') as UrdbRate;
    const result = urdbRateToSeasons(optionA, { medianMonthlyKwh: null, fallbackSellRate: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = compileSeasonsToParsedTariff(result.name, result.seasons);
    const tesla: Tariff = {
      id: 1, site_id: 'site-1', updated: new Date('2025-06-01T12:00:00Z'), name: optionA.utility,
      plan_name: 'Residential Time-of-Use Option A', plan_code: 'Rg 2',
      seasons: parsed.seasons.map(season => ({
        ...season,
        schedules: season.schedules.map(schedule => ({
          ...schedule,
          buy_rate: Math.round(schedule.buy_rate * 100) / 100,
        })),
      })) as unknown as Tariff['seasons'],
    };

    expect(teslaMatchesUrdb(tesla, optionA)).toBe(true);
    expect(pickTeslaMatch(tesla, [optionA])?.label).toBe(optionA.label);
  });
  it('rejects a Tesla cell outside the half-cent tolerance', () => {
    const optionA = weEnergiesEffective.find(item => item.label === '6859a6a4417690873a01fd68') as UrdbRate;
    const converted = urdbRateToSeasons(optionA, { medianMonthlyKwh: null, fallbackSellRate: 0 });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const parsed = compileSeasonsToParsedTariff(converted.name, converted.seasons);
    const tesla: Tariff = {
      id: 2, site_id: 'site-1', updated: new Date('2025-06-01T12:00:00Z'), name: optionA.utility,
      seasons: parsed.seasons.map((season, index) => ({
        ...season,
        schedules: season.schedules.map((schedule, scheduleIndex) => ({
          ...schedule,
          buy_rate: index === 0 && scheduleIndex === 0 ? schedule.buy_rate + 0.00501 : schedule.buy_rate,
        })),
      })) as unknown as Tariff['seasons'],
    };
    expect(teslaMatchesUrdb(tesla, optionA)).toBe(false);
  });
  it('walks the recorded We Energies Option A supersedes chain back to 2014', async () => {
    const byLabel = new Map((weEnergiesChain as UrdbRate[]).map(rate => [rate.label, rate]));
    const spans = await walkSupersedes(
      byLabel.get('6859a6a4417690873a01fd68') as UrdbRate,
      async label => byLabel.get(label) ?? null,
      { endBefore: null, maxSteps: 80, timeZone: 'America/Chicago' }
    );
    expect(spans).toHaveLength(10);
    expect(spans[0]?.effectiveFrom).toBe('2014-01-01');
    expect(spans.at(-1)).toMatchObject({ effectiveFrom: '2025-06-01', effectiveTo: null });
  });
  it('reads URDB start dates stored a few hours either side of UTC midnight as that calendar day', () => {
    const at = (iso: string): UrdbRate => ({ ...rate(iso, '2020-01-01'), startdate: Date.parse(iso) / 1000 });
    // Recorded fixtures store June 1, 2025 as 2025-05-31T23:00Z and local midnights as 01:00Z or 06:00Z.
    expect(referenceSpans([at('2025-05-31T23:00:00Z')], 'UTC')[0]?.effectiveFrom).toBe('2025-06-01');
    expect(referenceSpans([at('2025-06-01T06:00:00Z')], 'UTC')[0]?.effectiveFrom).toBe('2025-06-01');
    expect(anchorStart({ matched: at('2024-09-30T23:00:00Z'), firstSeen: '2025-01-01', isFirstVersion: true, currentSpanStart: '2023-01-01', ownerDated: false, timeZone: 'UTC' }))
      .toEqual({ startDate: '2024-10-01', startSource: 'urdb' });
    expect(anchorStart({ matched: { ...at('2020-01-01T00:00:00Z'), startdate: 1e20 }, firstSeen: '2025-01-01', isFirstVersion: false, currentSpanStart: '2023-01-01', ownerDated: false, timeZone: 'UTC' }))
      .toEqual({ startDate: '2025-01-01', startSource: 'tesla_first_seen' });
  });
  it('prefers the single-phase plan when single- and three-phase revisions price the same', () => {
    const optionA = weEnergiesEffective.find(item => item.label === '6859a6a4417690873a01fd68') as UrdbRate;
    const converted = urdbRateToSeasons(optionA, { medianMonthlyKwh: null, fallbackSellRate: 0 });
    if (!converted.ok) throw new Error('fixture must convert');
    const parsed = compileSeasonsToParsedTariff(converted.name, converted.seasons);
    const tesla: Tariff = {
      id: 3, site_id: 'site-1', updated: new Date('2025-06-01T12:00:00Z'), name: optionA.utility, plan_name: null, plan_code: null,
      seasons: parsed.seasons as unknown as Tariff['seasons'],
    };
    expect(pickTeslaMatch(tesla, weEnergiesEffective as UrdbRate[])?.label).toBe('6859a6a4417690873a01fd68');
  });
});

describe('estimate freshness', () => {
  const starts = (...dates: string[]) => dates;
  it('mayBeOutdatedAfterFifteenMonths', () => {
    const revisions = starts('2023-01-01', '2024-01-01', '2025-01-01', '2025-06-01');
    expect(estimateMayBeOutdated({ today: '2026-08-31', newestRevisionStart: '2025-06-01', revisionStarts: revisions })).toBe(false);
    expect(estimateMayBeOutdated({ today: '2026-09-02', newestRevisionStart: '2025-06-01', revisionStarts: revisions })).toBe(true);
  });
  it('mayBeOutdatedSoonerForFrequentChangers', () => {
    // Median gap 182 days: 1.5 x 182 = 273 days after 2025-07-01 is 2026-03-31.
    const revisions = starts('2024-01-01', '2024-07-01', '2025-01-01', '2025-07-01');
    expect(estimateMayBeOutdated({ today: '2026-03-31', newestRevisionStart: '2025-07-01', revisionStarts: revisions })).toBe(false);
    expect(estimateMayBeOutdated({ today: '2026-04-01', newestRevisionStart: '2025-07-01', revisionStarts: revisions })).toBe(true);
  });
  it('notOutdatedWithoutEstimateToday', () => {
    expect(estimateMayBeOutdated({ today: '2026-11-16', newestRevisionStart: null, revisionStarts: starts('2020-01-01', '2021-01-01', '2022-01-01') })).toBe(false);
  });
  it('fewRevisionsUseFifteenMonths', () => {
    // Two revisions: the gap is not a reliable median, so only the 15-month cap applies.
    const revisions = starts('2025-05-01', '2025-06-01');
    expect(estimateMayBeOutdated({ today: '2026-08-31', newestRevisionStart: '2025-06-01', revisionStarts: revisions })).toBe(false);
    expect(estimateMayBeOutdated({ today: '2026-09-02', newestRevisionStart: '2025-06-01', revisionStarts: revisions })).toBe(true);
  });
  it('flags the Harrison-like fixture (newest 2025-06-01, today 2026-11-16)', () => {
    expect(estimateMayBeOutdated({ today: '2026-11-16', newestRevisionStart: '2025-06-01', revisionStarts: starts('2014-01-01', '2020-01-01', '2025-06-01') })).toBe(true);
  });
  it('derives the newest revision and its staleness from the estimate covering today', () => {
    const sources = [
      { tariff_id: 1, role: 'estimated_actual', start_date: '2023-01-01' },
      { tariff_id: 2, role: 'estimated_actual', start_date: '2025-06-01' },
      { tariff_id: 9, role: 'estimated_reference', start_date: '2020-01-01' },
    ];
    const periods = [{ tariff_id: 2, source: 'estimated', effective_from: '2025-06-01', effective_to: null }];
    expect(estimateFreshness({ today: '2026-11-16', periodRows: periods, referencePeriodRows: [], sources }))
      .toEqual({ newestRevisionStart: '2025-06-01', mayBeOutdated: true });
  });
  it('falls back to the reference timeline when no actual estimate covers today', () => {
    const sources = [
      { tariff_id: 9, role: 'estimated_reference', start_date: '2024-01-01' },
      { tariff_id: 10, role: 'estimated_reference', start_date: '2026-10-01' },
    ];
    const reference = [{ tariff_id: 10, source: 'estimated', effective_from: '2026-10-01', effective_to: null }];
    expect(estimateFreshness({ today: '2026-11-16', periodRows: [], referencePeriodRows: reference, sources }))
      .toEqual({ newestRevisionStart: '2026-10-01', mayBeOutdated: false });
  });
  it('uses the URDB revision date, not the start clipped to the site history', () => {
    // History starts 2026-11-01, so the stored span starts there; the rates themselves date from 2025-06-01.
    const sources = [{ tariff_id: 4, role: 'estimated_actual', start_date: '2026-11-01', revision_start: '2025-06-01' }];
    const periods = [{ tariff_id: 4, source: 'estimated', effective_from: '2026-11-01', effective_to: null }];
    expect(estimateFreshness({ today: '2026-11-16', periodRows: periods, referencePeriodRows: [], sources }))
      .toEqual({ newestRevisionStart: '2025-06-01', mayBeOutdated: true });
  });
  it('reports no revision when no estimate covers today or manual plans cover it', () => {
    const sources = [{ tariff_id: 1, role: 'estimated_actual', start_date: '2023-01-01' }];
    const periods = [
      { tariff_id: 1, source: 'estimated', effective_from: '2023-01-01', effective_to: '2023-12-31' },
      { tariff_id: 5, source: 'manual', effective_from: '2024-01-01', effective_to: null },
    ];
    expect(estimateFreshness({ today: '2026-11-16', periodRows: periods, referencePeriodRows: [], sources }))
      .toEqual({ newestRevisionStart: null, mayBeOutdated: false });
  });
});

describe('closeness to the Tesla plan', () => {
  const byLabel = (label: string) => weEnergiesEffective.find(item => item.label === label) as UrdbRate;
  const optionA = byLabel('6859a6a4417690873a01fd68');
  const optionB = byLabel('685a177d100bd6b82a005dc0');
  const rg1 = byLabel('6859a625ee417fe3fa0cb0df');
  const window = (touName: TimePeriodWindowInput['touName'], fromHour: number, toHour: number, buyRate: number): TimePeriodWindowInput => ({ touName, fromHour, fromMinute: 0, toHour, toMinute: 0, buyRate, sellRate: 0 });
  const teslaFrom = (seasons: TariffSeasonInput[]): Tariff => ({
    id: 9, site_id: 'site-1', updated: new Date('2025-06-01T12:00:00Z'), name: 'U',
    seasons: compileSeasonsToParsedTariff('Plan', seasons).seasons as unknown as Tariff['seasons'],
  });
  const touSeason = (name: string, fromMonth: number, toMonth: number, peak: number): TariffSeasonInput => ({
    name, fromMonth, toMonth,
    weekdayPeriods: [window('OFF_PEAK', 0, 8, 0.1), window('ON_PEAK', 8, 20, peak), window('OFF_PEAK', 20, 24, 0.1)],
    weekendPeriods: [window('OFF_PEAK', 0, 24, 0.1)],
  });
  const harrison = teslaFrom([touSeason('Summer', 6, 9, 0.3), touSeason('Winter', 10, 5, 0.31)]);
  const flatSeason = (rateValue: number): TariffSeasonInput => ({ name: 'All', fromMonth: 1, toMonth: 12, weekdayPeriods: [window('OFF_PEAK', 0, 24, rateValue)], weekendPeriods: [window('OFF_PEAK', 0, 24, rateValue)] });
  const flatRate = (rateValue: number, adj: number): UrdbRate => ({ ...rate('flat', '2020-01-01'), energyratestructure: [[{ rate: rateValue, adj }]] });

  it('distanceIsZeroForTheSameRevision', () => {
    const converted = urdbRateToSeasons(optionA, { medianMonthlyKwh: null, fallbackSellRate: 0 });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const tesla = teslaFrom(converted.seasons);
    expect(buyRateDistance(tesla, optionA)).toBeLessThan(0.0001);
  });
  it('harrisonPlanIsClosestToOptionB', () => {
    const options = weEnergiesEffective.filter(item => /Single-Phase, Option [A-D]\) Rg 2/.test(item.name)) as UrdbRate[];
    expect(options).toHaveLength(4);
    const ranked = options.map(item => ({ name: item.name, distance: buyRateDistance(harrison, item) as number })).sort((a, b) => a.distance - b.distance);
    expect(ranked[0].name).toContain('Option B');
    expect(ranked[0].distance).toBeLessThan(ranked[1].distance);
    expect(buyRateDistance(harrison, optionB)).toBeLessThan(0.03);
  });
  it('distanceUsesTheSmallerOfWithAndWithoutAdj', () => {
    expect(buyRateDistance(teslaFrom([flatSeason(0.1)]), flatRate(0.1, 0.01))).toBeCloseTo(0, 10);
    expect(buyRateDistance(teslaFrom([flatSeason(0.11)]), flatRate(0.1, 0.01))).toBeCloseTo(0, 10);
    expect(buyRateDistance(teslaFrom([flatSeason(0.105)]), flatRate(0.1, 0.01))).toBeCloseTo(0.005, 10);
  });
  it('distanceIsNullWhenACellHasNoRate', () => {
    expect(buyRateDistance(harrison, { ...flatRate(0.1, 0), energyratestructure: [[{}]] })).toBeNull();
  });
  it('teslaShapeTimeOfUseWithTwoPrices', () => {
    expect(teslaShape(teslaFrom([touSeason('Summer', 6, 9, 0.3), touSeason('Winter', 10, 5, 0.3)]))).toBe('time_of_use');
  });
  it('teslaShapeFixedWithOnePrice', () => {
    expect(teslaShape(teslaFrom([flatSeason(0.2)]))).toBe('fixed');
  });
  it('teslaShapeFixedWithSeasonalPricesOnly', () => {
    const season = (name: string, fromMonth: number, toMonth: number, price: number): TariffSeasonInput => ({ ...flatSeason(price), name, fromMonth, toMonth });
    expect(teslaShape(teslaFrom([season('Summer', 6, 9, 0.2), season('Winter', 10, 5, 0.15)]))).toBe('fixed');
  });
  it('teslaShapeTimeOfUseWhenOnlyWeekendsDiffer', () => {
    expect(teslaShape(teslaFrom([{ ...flatSeason(0.2), weekendPeriods: [window('OFF_PEAK', 0, 24, 0.15)] }]))).toBe('time_of_use');
  });
  it('teslaShapeNullWithoutPlan', () => {
    expect(teslaShape(null)).toBeNull();
  });
  it('planKindFromIsFixedRate', () => {
    expect(planKind(rg1)).toBe('fixed');
    expect(planKind(optionA)).toBe('time_of_use');
  });
});

describe('newerRevision', () => {
  // Five unrelated plans, each revised yearly back to 2015, plus the chosen plan's own newer revision.
  const unrelated = Array.from({ length: 5 }, (_, plan) => Array.from({ length: 10 }, (_, step) => rate(`p${plan}-${2025 - step}`, `${2025 - step}-06-01`, step < 9 ? `p${plan}-${2024 - step}` : undefined))).flat();
  const chosen = { ...rate('mine-2022', '2022-06-01', 'mine-2021'), name: 'Mine' };
  const middle = { ...rate('mine-2023', '2023-06-01', 'mine-2022'), name: 'Mine' };
  const newest = { ...rate('mine-2025', '2025-06-01', 'mine-2023'), name: 'Mine' };
  const all = new Map([...unrelated, chosen, middle, newest].map(entry => [entry.label, entry]));
  const today = [...unrelated.filter(entry => entry.label.endsWith('2025')), newest];
  function counting() {
    const fetched: string[] = [];
    return { fetched, fetch: async (label: string) => { fetched.push(label); return all.get(label) ?? null; } };
  }
  it('findsTheChosenPlansNewestRevisionWithFewFetches', async () => {
    const { fetched, fetch } = counting();
    expect((await newerRevision(chosen, today, fetch))?.label).toBe('mine-2025');
    expect(fetched.length).toBeLessThanOrEqual(2);
  });
  it('stopsWalkingUnrelatedPlansOlderThanTheChosenOne', async () => {
    const { fetched, fetch } = counting();
    const orphan = { ...rate('orphan-2022', '2022-06-01'), name: 'Orphan' };
    expect(await newerRevision(orphan, today.filter(entry => entry.label !== 'mine-2025'), fetch)).toBeNull();
    expect(fetched.length).toBeLessThanOrEqual(5 * 4);
  });
  it('directSuccessorNeedsNoFetch', async () => {
    const { fetched, fetch } = counting();
    expect((await newerRevision(middle, today, fetch))?.label).toBe('mine-2025');
    expect(fetched).toEqual([]);
  });
});
