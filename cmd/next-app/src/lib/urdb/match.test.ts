import { describe, expect, it } from 'vitest';
import { anchorStart, pickTeslaMatch, referenceSpans, teslaMatchesUrdb, walkSupersedes } from './match';
import { compileSeasonsToParsedTariff } from '../tariff-timeline';
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
});
