import { describe, expect, it } from 'vitest';
import type { TariffSeasonInput, TimePeriodWindowInput } from './tariff-contract';
import { applyTeslaAdjustments, teslaPlansMatch } from './tesla-tou-sync';

function win(
  touName: TimePeriodWindowInput['touName'],
  fromHour: number,
  toHour: number,
  buyRate: number,
  sellRate: number,
): TimePeriodWindowInput {
  return { touName, fromHour, fromMinute: 0, toHour, toMinute: 0, buyRate, sellRate };
}

function season(overrides: Partial<TariffSeasonInput> = {}): TariffSeasonInput {
  return {
    name: 'Summer',
    fromMonth: 6,
    toMonth: 9,
    fromDay: 1,
    toDay: 30,
    weekdayPeriods: [
      win('OFF_PEAK', 0, 16, 0.1, 0.05),
      win('ON_PEAK', 16, 21, 0.3, 0.12),
      win('OFF_PEAK', 21, 24, 0.1, 0.05),
    ],
    weekendPeriods: [win('OFF_PEAK', 0, 24, 0.1, 0.05)],
    ...overrides,
  };
}

describe('teslaPlansMatch', () => {
  it('matches identical content with different plan and season names', () => {
    const pwusage = [season({ name: 'Summer' })];
    const tesla = [season({ name: 'Season 1' })];
    expect(teslaPlansMatch(pwusage, tesla)).toBe(true);
  });

  it('matches regardless of window ordering', () => {
    const pwusage = [season()];
    const tesla = [season({ weekdayPeriods: [...season().weekdayPeriods].reverse() })];
    expect(teslaPlansMatch(pwusage, tesla)).toBe(true);
  });

  it('matches regardless of season ordering', () => {
    const winter = season({ name: 'Winter', fromMonth: 10, toMonth: 5, fromDay: 1, toDay: 31 });
    const summer = season();
    expect(teslaPlansMatch([summer, winter], [winter, summer])).toBe(true);
  });

  it('matches when rates differ only past 5 decimals', () => {
    const pwusage = [season({ weekendPeriods: [win('OFF_PEAK', 0, 24, 0.100001, 0.05)] })];
    const tesla = [season({ weekendPeriods: [win('OFF_PEAK', 0, 24, 0.1, 0.05)] })];
    expect(teslaPlansMatch(pwusage, tesla)).toBe(true);
  });

  it('differs on a moved window', () => {
    const pwusage = [season()];
    const tesla = [season({ weekdayPeriods: [
      win('OFF_PEAK', 0, 17, 0.1, 0.05),
      win('ON_PEAK', 17, 21, 0.3, 0.12),
      win('OFF_PEAK', 21, 24, 0.1, 0.05),
    ] })];
    expect(teslaPlansMatch(pwusage, tesla)).toBe(false);
  });

  it('differs on a changed buy rate', () => {
    const pwusage = [season()];
    const tesla = [season({ weekdayPeriods: [
      win('OFF_PEAK', 0, 16, 0.11, 0.05),
      win('ON_PEAK', 16, 21, 0.3, 0.12),
      win('OFF_PEAK', 21, 24, 0.1, 0.05),
    ] })];
    expect(teslaPlansMatch(pwusage, tesla)).toBe(false);
  });

  it('differs on a season boundary', () => {
    const pwusage = [season()];
    const tesla = [season({ toDay: 29 })];
    expect(teslaPlansMatch(pwusage, tesla)).toBe(false);
  });

  it('differs when the season count differs', () => {
    const pwusage = [season()];
    const tesla = [season(), season({ name: 'Winter', fromMonth: 10, toMonth: 5 })];
    expect(teslaPlansMatch(pwusage, tesla)).toBe(false);
  });

  it('matches after Tesla raises buy to sell', () => {
    const pwusage = [season({ weekdayPeriods: [win('ON_PEAK', 16, 21, 0.1, 0.12)], weekendPeriods: [] })];
    const tesla = [season({ weekdayPeriods: [win('ON_PEAK', 16, 21, 0.12, 0.12)], weekendPeriods: [] })];
    expect(teslaPlansMatch(pwusage, tesla)).toBe(true);
  });

  it('matches after Tesla zeroes a negative price', () => {
    const pwusage = [season({ weekdayPeriods: [win('OFF_PEAK', 0, 24, -0.02, -0.01)], weekendPeriods: [] })];
    const tesla = [season({ weekdayPeriods: [win('OFF_PEAK', 0, 24, 0, 0)], weekendPeriods: [] })];
    expect(teslaPlansMatch(pwusage, tesla)).toBe(true);
  });

  it('differs on currency', () => {
    const pwusage = [season()];
    const tesla = [season()];
    expect(teslaPlansMatch(pwusage, tesla, { pwusageCurrency: 'USD', teslaCurrency: 'EUR' })).toBe(false);
  });

  it('matches currency case-insensitively and when only one side is given', () => {
    const pwusage = [season()];
    const tesla = [season()];
    expect(teslaPlansMatch(pwusage, tesla, { pwusageCurrency: 'usd', teslaCurrency: 'USD' })).toBe(true);
    expect(teslaPlansMatch(pwusage, tesla, { pwusageCurrency: 'USD' })).toBe(true);
  });
});

describe('applyTeslaAdjustments', () => {
  it('lists each adjustment', () => {
    const pwusage = [season({
      name: 'Summer',
      weekdayPeriods: [
        win('ON_PEAK', 16, 21, 0.1, 0.12),
        win('OFF_PEAK', 0, 16, -0.02, 0.05),
        win('PARTIAL_PEAK', 0, 1, -0.02, -0.01),
      ],
      weekendPeriods: [win('OFF_PEAK', 0, 24, 0.1, -0.01)],
    })];
    const result = applyTeslaAdjustments(pwusage);
    expect(result.adjustments).toEqual([
      { season: 'Summer', period: 'ON_PEAK', side: 'buy', from: 0.1, to: 0.12, reason: 'raised_to_sell' },
      { season: 'Summer', period: 'OFF_PEAK', side: 'buy', from: -0.02, to: 0.05, reason: 'raised_to_sell' },
      { season: 'Summer', period: 'PARTIAL_PEAK', side: 'buy', from: -0.02, to: 0, reason: 'negative_to_zero' },
      { season: 'Summer', period: 'PARTIAL_PEAK', side: 'sell', from: -0.01, to: 0, reason: 'negative_to_zero' },
      { season: 'Summer', period: 'OFF_PEAK', side: 'sell', from: -0.01, to: 0, reason: 'negative_to_zero' },
    ]);
    expect(result.seasons[0].weekdayPeriods[0]).toMatchObject({ buyRate: 0.12, sellRate: 0.12 });
    expect(result.seasons[0].weekdayPeriods[1]).toMatchObject({ buyRate: 0.05, sellRate: 0.05 });
    expect(result.seasons[0].weekdayPeriods[2]).toMatchObject({ buyRate: 0, sellRate: 0 });
    expect(result.seasons[0].weekendPeriods[0]).toMatchObject({ buyRate: 0.1, sellRate: 0 });
  });

  it('does not mutate its input', () => {
    const pwusage = [season({ weekdayPeriods: [win('ON_PEAK', 16, 21, 0.1, 0.12)], weekendPeriods: [] })];
    applyTeslaAdjustments(pwusage);
    expect(pwusage[0].weekdayPeriods[0].buyRate).toBe(0.1);
  });
});
