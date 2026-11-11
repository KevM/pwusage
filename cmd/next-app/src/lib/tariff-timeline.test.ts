import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  compileSeasonsToParsedTariff,
  computeSpanMutations,
  decompileTariffToSeasons,
  siteLocalDateString,
  TariffValidationError,
  validateTariffPlanInput,
} from './tariff-timeline';
import type { TariffSeasonInput } from './tariff-contract';

const weEnergiesSeasons: TariffSeasonInput[] = [
  {
    name: 'Winter',
    fromMonth: 10,
    toMonth: 5,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 },
      { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.31335, sellRate: 0.03863 },
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 },
    ],
  },
  {
    name: 'Summer',
    fromMonth: 6,
    toMonth: 9,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.10279, sellRate: 0.03290 },
      { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.30335, sellRate: 0.04906 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03290 },
    ],
  },
];

describe('validateTariffPlanInput', () => {
  it('accepts valid 5-decimal rates, wraparound seasons, and midnight-crossing windows', () => {
    const validated = validateTariffPlanInput({
      name: '  We Energies Rg2  ',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      seasons: weEnergiesSeasons,
    }, '2026-11-11');
    expect(validated.name).toBe('We Energies Rg2');
    expect(validated.seasons[1].weekdayPeriods[0].buyRate).toBe(0.10279);
  });

  it('rejects > 5 decimal places, missing months, zero-length periods, > 48 periods, or gaps in 24h weekday schedule', () => {
    const badDecimal = structuredClone(weEnergiesSeasons);
    badDecimal[0].weekdayPeriods[0].buyRate = 0.123456;
    expect(() => validateTariffPlanInput({
      name: 'Bad', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: badDecimal,
    }, '2026-11-11')).toThrow(TariffValidationError);

    const missingMonth = structuredClone(weEnergiesSeasons);
    missingMonth[0].toMonth = 4; // drops May
    expect(() => validateTariffPlanInput({
      name: 'Gap', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: missingMonth,
    }, '2026-11-11')).toThrow(/12 months/i);

    const gapHours = structuredClone(weEnergiesSeasons);
    gapHours[1].weekendPeriods = [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 23, toMinute: 30, buyRate: 0.1, sellRate: 0.03 },
    ];
    expect(() => validateTariffPlanInput({
      name: 'GapHour', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: gapHours,
    }, '2026-11-11')).toThrow(/24 hours/i);

    const zeroLength = structuredClone(weEnergiesSeasons);
    zeroLength[1].weekendPeriods = [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 0, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
      { touName: 'ON_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.2, sellRate: 0.03 },
    ];
    expect(() => validateTariffPlanInput({
      name: 'ZeroLen', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: zeroLength,
    }, '2026-11-11')).toThrow(TariffValidationError);

    const tooManyPeriods = structuredClone(weEnergiesSeasons);
    tooManyPeriods[1].weekendPeriods = Array.from({ length: 49 }, (_, i) => ({
      touName: 'OFF_PEAK' as const,
      fromHour: Math.floor((i % 48) / 2),
      fromMinute: (i % 2) * 30,
      toHour: Math.floor(((i % 48) + 1) / 2),
      toMinute: ((i % 48 + 1) % 2) * 30,
      buyRate: 0.1,
      sellRate: 0.03,
    }));
    expect(() => validateTariffPlanInput({
      name: 'TooMany', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: tooManyPeriods,
    }, '2026-11-11')).toThrow(TariffValidationError);
  });

  it('rejects invalid effective dates (effectiveTo < effectiveFrom, pre-2015, > today + 365d)', () => {
    expect(() => validateTariffPlanInput({
      name: 'Bad Range', effectiveFrom: '2026-05-01', effectiveTo: '2026-04-30', seasons: weEnergiesSeasons,
    }, '2026-11-11')).toThrow(TariffValidationError);

    expect(() => validateTariffPlanInput({
      name: 'Too Old', effectiveFrom: '2014-12-31', effectiveTo: null, seasons: weEnergiesSeasons,
    }, '2026-11-11')).toThrow(TariffValidationError);

    expect(() => validateTariffPlanInput({
      name: 'Too Far Future', effectiveFrom: '2027-11-12', effectiveTo: null, seasons: weEnergiesSeasons,
    }, '2026-11-11')).toThrow(TariffValidationError);
  });
});

describe('compileSeasonsToParsedTariff & decompileTariffToSeasons', () => {
  it('preserves Feb 29 leap-day end boundary and 5-decimal rates round-trip', () => {
    const parsed = compileSeasonsToParsedTariff('Test', [
      {
        name: 'Winter',
        fromMonth: 12,
        toMonth: 2,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 }],
      },
      {
        name: 'Warm',
        fromMonth: 3,
        toMonth: 11,
        weekdayPeriods: [{ touName: 'ON_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.30335, sellRate: 0.04906 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.0329 }],
      },
    ]);
    expect(parsed.seasons[0].to_day).toBe(29);
    const roundTripped = decompileTariffToSeasons({
      id: 1, site_id: 's1', updated: new Date(), name: parsed.name,
      seasons: parsed.seasons.map((s, idx) => ({
        id: idx + 1, tariff_id: 1, ...s,
        schedules: s.schedules.map((sch, j) => ({ id: idx * 10 + j + 1, season_id: idx + 1, ...sch })),
      })),
    });
    expect(roundTripped[0].weekdayPeriods[0].buyRate).toBe(0.10279);
  });

  it('resolves layered Tesla schedules into non-overlapping 24h windows using Schedule specificity', () => {
    const decompiled = decompileTariffToSeasons({
      id: 2,
      site_id: 's1',
      updated: new Date(),
      name: 'Layered Tesla Plan',
      seasons: [{
        id: 10,
        tariff_id: 2,
        name: 'All Year',
        from_month: 1,
        from_day: 1,
        to_month: 12,
        to_day: 31,
        buy_rate: 0.1,
        sell_rate: 0.03,
        schedules: [
          // Every day all-day baseline
          { id: 1, season_id: 10, name: 'OFF_PEAK', buy_rate: 0.1, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
          // Narrower Mon-Fri peak override (overlaps 0..6 baseline in raw rows)
          { id: 2, season_id: 10, name: 'ON_PEAK', buy_rate: 0.3, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 4, from_hour: 8, from_minute: 0, to_hour: 20, to_minute: 0 },
        ],
      }],
    });
    expect(decompiled[0].weekdayPeriods).toEqual([
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
      { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.3, sellRate: 0.05 },
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
    ]);
    expect(decompiled[0].weekendPeriods).toEqual([
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
    ]);
    expect(() => validateTariffPlanInput({
      name: 'Layered Tesla Plan', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: decompiled,
    }, '2026-11-11')).not.toThrow();
  });
});

describe('computeSpanMutations', () => {
  it('splits an enclosing tesla span around a bounded manual period while keeping untouched author metadata', () => {
    const plan = computeSpanMutations(
      [{ id: 10, tariffId: 82, source: 'tesla', effectiveFrom: '2024-01-01', effectiveTo: null, updatedByUserId: null }],
      { tariffId: 90, source: 'manual', effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', updatedByUserId: 'user-1' }
    );
    expect(plan.deleteIds).toEqual([10]);
    expect(plan.inserts).toEqual([
      { tariffId: 82, source: 'tesla', effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31', updatedByUserId: null },
      { tariffId: 82, source: 'tesla', effectiveFrom: '2026-01-01', effectiveTo: null, updatedByUserId: null },
      { tariffId: 90, source: 'manual', effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', updatedByUserId: 'user-1' },
    ]);
    expect(addCalendarDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(siteLocalDateString(new Date('2026-01-01T05:30:00Z'), 'America/Chicago')).toBe('2025-12-31');
  });

  it('trims left/right neighbors and replaces strictly contained spans', () => {
    const plan = computeSpanMutations(
      [
        { id: 1, tariffId: 10, source: 'tesla', effectiveFrom: '2024-01-01', effectiveTo: '2024-06-30', updatedByUserId: null },
        { id: 2, tariffId: 11, source: 'manual', effectiveFrom: '2024-07-01', effectiveTo: '2024-12-31', updatedByUserId: 'u-old' },
        { id: 3, tariffId: 12, source: 'tesla', effectiveFrom: '2025-01-01', effectiveTo: null, updatedByUserId: 'u-adj' },
      ],
      { tariffId: 99, source: 'manual', effectiveFrom: '2024-05-01', effectiveTo: '2025-03-31', updatedByUserId: 'u-new' }
    );
    expect(plan.deleteIds).toEqual([1, 2, 3]);
    expect(plan.inserts).toEqual([
      { tariffId: 10, source: 'tesla', effectiveFrom: '2024-01-01', effectiveTo: '2024-04-30', updatedByUserId: null },
      { tariffId: 12, source: 'tesla', effectiveFrom: '2025-04-01', effectiveTo: null, updatedByUserId: 'u-adj' },
      { tariffId: 99, source: 'manual', effectiveFrom: '2024-05-01', effectiveTo: '2025-03-31', updatedByUserId: 'u-new' },
    ]);
  });
});
