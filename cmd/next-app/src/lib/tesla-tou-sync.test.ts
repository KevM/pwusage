import { describe, expect, it } from 'vitest';
import type { TariffSeasonInput, TimePeriodWindowInput } from './tariff-contract';
import fixtureJson from './__fixtures__/tesla-tariff-two-season.json';
import type { TariffV2 } from './tesla-client';
import type { Tariff } from './db-types';
import { parseTariffContent } from './importer/tariff-parser';
import { decompileTariffToSeasons } from './tariff-timeline';
import {
  applyTeslaAdjustments,
  buildTeslaTariff,
  teslaPlansMatch,
  validateForTesla,
} from './tesla-tou-sync';

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

const teslaFixture = fixtureJson as unknown as TariffV2;

/** Parse Tesla's content, then decompile it back into PWUsage's season shape. */
function seasonsOf(content: TariffV2): TariffSeasonInput[] {
  const parsed = parseTariffContent(content, 'Site');
  const tariff: Tariff = {
    id: 0,
    site_id: 'test-site',
    updated: new Date(0),
    name: parsed.name,
    seasons: parsed.seasons.map((season, seasonIndex) => ({
      id: seasonIndex,
      tariff_id: 0,
      ...season,
      schedules: season.schedules.map((schedule, i) => ({ id: i, season_id: seasonIndex, ...schedule })),
    })),
  };
  return decompileTariffToSeasons(tariff);
}

const FOUR_LABELS = new Set(['ON_PEAK', 'PARTIAL_PEAK', 'OFF_PEAK', 'SUPER_OFF_PEAK']);

function winterSeason(): TariffSeasonInput {
  return season({ name: 'Winter', fromMonth: 10, toMonth: 5, fromDay: 1, toDay: 31 });
}

/** Full-year, valid plan: Summer Jun-Sep, Winter Oct-May. */
function validPlan(): TariffSeasonInput[] {
  return [
    season({ name: 'Summer' }),
    season({ name: 'Winter', fromMonth: 10, toMonth: 5, fromDay: 1, toDay: 31 }),
  ];
}

describe('buildTeslaTariff', () => {
  it('round-trips Tesla\'s own plan', () => {
    const rebuilt = buildTeslaTariff(teslaFixture, { name: 'Sample', seasons: seasonsOf(teslaFixture) });
    expect(teslaPlansMatch(seasonsOf(teslaFixture), seasonsOf(rebuilt))).toBe(true);
  });

  it('rebuilds Tesla\'s season periods and rates exactly', () => {
    const rebuilt = buildTeslaTariff(teslaFixture, { name: 'Sample', seasons: seasonsOf(teslaFixture) });
    expect(rebuilt.seasons).toEqual(teslaFixture.seasons);
    expect(rebuilt.energy_charges).toEqual(teslaFixture.energy_charges);
    expect(rebuilt.sell_tariff.seasons).toEqual(teslaFixture.sell_tariff.seasons);
    expect(rebuilt.sell_tariff.energy_charges).toEqual(teslaFixture.sell_tariff.energy_charges);
  });

  it('keeps unmodeled fields from the base', () => {
    const rebuilt = buildTeslaTariff(teslaFixture, { name: 'Sample', seasons: seasonsOf(teslaFixture) }) as unknown as Record<string, unknown>;
    const base = teslaFixture as unknown as Record<string, unknown>;
    expect(rebuilt.daily_charges).toEqual(base.daily_charges);
    expect(rebuilt.demand_charges).toEqual(base.demand_charges);
    expect(rebuilt.utility).toBe(base.utility);
    expect(rebuilt.code).toBe(base.code);
    expect(rebuilt.currency).toBe(base.currency);
    expect(rebuilt.sell_tariff).toMatchObject({ name: 'Sample Export', utility: 'Sample Electric' });
  });

  it('sets the name and uses only Tesla period labels', () => {
    const rebuilt = buildTeslaTariff(teslaFixture, { name: 'PWUsage Plan', seasons: validPlan() });
    expect(rebuilt.name).toBe('PWUsage Plan');
    const labels = new Set<string>();
    for (const charges of [rebuilt.energy_charges, rebuilt.sell_tariff.energy_charges]) {
      for (const [group, charge] of Object.entries(charges)) {
        if (group === 'ALL') continue;
        Object.keys(charge.rates).forEach(label => labels.add(label));
      }
    }
    for (const season of Object.values(rebuilt.seasons)) {
      Object.keys(season.tou_periods).forEach(label => labels.add(label));
    }
    labels.forEach(label => expect(FOUR_LABELS.has(label)).toBe(true));
  });

  it('keeps five decimals', () => {
    const plan = validPlan();
    plan[0].weekdayPeriods[1] = win('ON_PEAK', 16, 21, 0.12345, 0.012346);
    const rebuilt = buildTeslaTariff(teslaFixture, { name: 'Five', seasons: plan });
    expect(rebuilt.energy_charges.Summer.rates.ON_PEAK).toBe(0.12345);
    expect(rebuilt.sell_tariff.energy_charges.Summer.rates.ON_PEAK).toBe(0.01235);
  });

  it('keeps the ALL placeholder from the base', () => {
    const rebuilt = buildTeslaTariff(teslaFixture, { name: 'Sample', seasons: validPlan() });
    expect(rebuilt.energy_charges.ALL).toEqual({ rates: { ALL: 0 } });
    expect(rebuilt.sell_tariff.energy_charges.ALL).toEqual({ rates: { ALL: 0 } });
  });

  it('creates a sell tariff with the ALL placeholder when the base has none', () => {
    const base = structuredClone(teslaFixture) as Partial<TariffV2> as TariffV2;
    delete (base as Partial<TariffV2>).sell_tariff;
    const rebuilt = buildTeslaTariff(base, { name: 'No Sell', seasons: validPlan() });
    expect(rebuilt.sell_tariff.seasons).toEqual(rebuilt.seasons);
    expect(rebuilt.sell_tariff.energy_charges.ALL).toEqual({ rates: { ALL: 0 } });
    expect(rebuilt.sell_tariff.energy_charges.Summer.rates.ON_PEAK).toBe(0.12);
  });

  it('does not mutate the base', () => {
    const before = JSON.stringify(teslaFixture);
    buildTeslaTariff(teslaFixture, { name: 'Sample', seasons: validPlan() });
    expect(JSON.stringify(teslaFixture)).toBe(before);
  });
});

describe('validateForTesla', () => {
  const codes = (problems: ReturnType<typeof validateForTesla>) => problems.map(p => p.code);

  it('passes a Tesla plan, a manual plan and a public plan', () => {
    expect(validateForTesla(seasonsOf(teslaFixture), 'USD')).toEqual([]);
    expect(validateForTesla(validPlan(), 'USD')).toEqual([]);
    const publicPlan: TariffSeasonInput[] = [
      {
        name: 'All Year',
        fromMonth: 1,
        toMonth: 12,
        weekdayPeriods: [
          win('SUPER_OFF_PEAK', 0, 6, 0.08123, 0.02),
          win('PARTIAL_PEAK', 6, 16, 0.13456, 0.03),
          win('ON_PEAK', 16, 21, 0.31789, 0.06),
          win('PARTIAL_PEAK', 21, 24, 0.13456, 0.03),
        ],
        weekendPeriods: [win('OFF_PEAK', 0, 24, 0.1, 0.02)],
      },
    ];
    expect(validateForTesla(publicPlan, 'USD')).toEqual([]);
  });

  it('reports a season_gap for a plan missing December', () => {
    const plan = [season({ name: 'Summer', fromMonth: 1, toMonth: 11, fromDay: 1, toDay: 30 })];
    const problems = validateForTesla(plan, 'USD');
    expect(codes(problems)).toEqual(['season_gap']);
    expect(problems[0].message).toContain('December');
  });

  it('reports a season_overlap when two seasons cover July', () => {
    const plan = [
      season({ name: 'Summer', fromMonth: 6, toMonth: 9, fromDay: 1, toDay: 30 }),
      season({ name: 'Winter', fromMonth: 7, toMonth: 5, fromDay: 1, toDay: 31 }),
    ];
    const problems = validateForTesla(plan, 'USD');
    expect(codes(problems)).toContain('season_overlap');
    expect(problems.find(p => p.code === 'season_overlap')?.message).toContain('July');
  });

  it('reports an hour_gap for weekdays uncovered from 23:00 to 24:00', () => {
    const plan = [season({ weekdayPeriods: [
      win('OFF_PEAK', 0, 16, 0.1, 0.05),
      win('ON_PEAK', 16, 21, 0.3, 0.12),
      win('OFF_PEAK', 21, 23, 0.1, 0.05),
    ] }), winterSeason()];
    const problems = validateForTesla(plan, 'USD');
    expect(codes(problems)).toEqual(['hour_gap']);
    expect(problems[0]).toMatchObject({ season: 'Summer' });
    expect(problems[0].message).toContain('23:00');
    expect(problems[0].message).toContain('weekday');
  });

  it('reports an hour_overlap when two weekday windows share an hour', () => {
    const plan = [season({ weekdayPeriods: [
      win('OFF_PEAK', 0, 16, 0.1, 0.05),
      win('ON_PEAK', 15, 21, 0.3, 0.12),
      win('OFF_PEAK', 21, 24, 0.1, 0.05),
    ] }), winterSeason()];
    expect(codes(validateForTesla(plan, 'USD'))).toEqual(['hour_overlap']);
  });

  it('names the season and label when one label has two rates', () => {
    const plan = [season({ weekdayPeriods: [
      win('OFF_PEAK', 0, 16, 0.1, 0.05),
      win('ON_PEAK', 16, 21, 0.3, 0.12),
      win('OFF_PEAK', 21, 24, 0.12, 0.05),
    ] }), winterSeason()];
    const problems = validateForTesla(plan, 'USD');
    expect(problems).toEqual([
      expect.objectContaining({ code: 'label_rate_conflict', season: 'Summer', period: 'OFF_PEAK' }),
    ]);
    expect(problems[0].message).toContain('Summer');
    expect(problems[0].message).toContain('OFF_PEAK');
  });

  it('reports season_name_conflict for two seasons with one name', () => {
    const plan = [
      season({ name: 'Winter', fromMonth: 6, toMonth: 9, fromDay: 1, toDay: 30 }),
      season({ name: 'Winter', fromMonth: 10, toMonth: 5, fromDay: 1, toDay: 31 }),
    ];
    const problems = validateForTesla(plan, 'USD');
    expect(problems).toEqual([expect.objectContaining({ code: 'season_name_conflict', season: 'Winter' })]);
    expect(problems[0].message).toContain('Winter');
  });

  it('reports season_name_conflict for a season named ALL', () => {
    const plan = [
      season({ name: 'ALL', fromMonth: 6, toMonth: 9, fromDay: 1, toDay: 30 }),
      season({ name: 'Winter', fromMonth: 10, toMonth: 5, fromDay: 1, toDay: 31 }),
    ];
    const problems = validateForTesla(plan, 'USD');
    expect(problems).toEqual([expect.objectContaining({ code: 'season_name_conflict', season: 'ALL' })]);
  });

  it('reports a currency Tesla does not store', () => {
    const problems = validateForTesla(validPlan(), 'CAD');
    expect(codes(problems)).toEqual(['currency']);
    expect(problems[0].message).toContain('CAD');
  });
});
