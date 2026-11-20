import type { TariffPeriodName, TariffSeasonInput, TimePeriodWindowInput } from './tariff-contract';
import type { Tariff } from './db-types';
import { parseTariffContent } from './importer/tariff-parser';
import type { EnergyChargeRates, Season, SeasonPeriods, TariffV2 } from './tesla-client';
import { compileSeasonsToParsedTariff, decompileTariffToSeasons } from './tariff-timeline';

export type TeslaRateAdjustment = {
  season: string;
  period: TariffPeriodName;
  side: 'buy' | 'sell';
  from: number;
  to: number;
  reason: 'raised_to_sell' | 'negative_to_zero';
};

export interface TeslaPlanMatchOptions {
  pwusageCurrency?: string;
  teslaCurrency?: string;
}

/** Rates are compared after rounding to 5 decimals. `+ 0` turns -0 into 0. */
function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5 + 0;
}

function rate5(value: number): string {
  return round5(value).toFixed(5);
}

/**
 * Tesla stores buy < sell as buy = sell, and negative prices as zero. Returns PWUsage's seasons
 * with those adjustments applied, plus one entry per rate Tesla would change. Input is not mutated.
 */
export function applyTeslaAdjustments(seasons: TariffSeasonInput[]): {
  seasons: TariffSeasonInput[];
  adjustments: TeslaRateAdjustment[];
} {
  const adjustments: TeslaRateAdjustment[] = [];

  const adjustWindow = (
    seasonName: string,
    window: TimePeriodWindowInput,
  ): TimePeriodWindowInput => {
    const sellRate = round5(window.sellRate) < 0 ? 0 : window.sellRate;
    const clampedBuy = round5(window.buyRate) < 0 ? 0 : window.buyRate;
    const buyRate = round5(clampedBuy) < round5(sellRate) ? sellRate : clampedBuy;

    // One entry per changed side: a negative buy that Tesla also raises to the export rate is a single raise.
    if (round5(buyRate) !== round5(window.buyRate)) {
      adjustments.push({
        season: seasonName,
        period: window.touName,
        side: 'buy',
        from: window.buyRate,
        to: buyRate,
        reason: round5(clampedBuy) < round5(sellRate) ? 'raised_to_sell' : 'negative_to_zero',
      });
    }
    if (round5(sellRate) !== round5(window.sellRate)) {
      adjustments.push({
        season: seasonName,
        period: window.touName,
        side: 'sell',
        from: window.sellRate,
        to: sellRate,
        reason: 'negative_to_zero',
      });
    }

    return { ...window, buyRate, sellRate };
  };

  const adjusted = seasons.map(season => ({
    ...season,
    weekdayPeriods: season.weekdayPeriods.map(w => adjustWindow(season.name, w)),
    weekendPeriods: season.weekendPeriods.map(w => adjustWindow(season.name, w)),
  }));

  return { seasons: adjusted, adjustments };
}

function windowSignature(window: TimePeriodWindowInput): string {
  return [
    window.touName,
    `${window.fromHour}:${window.fromMinute}-${window.toHour}:${window.toMinute}`,
    rate5(window.buyRate),
    rate5(window.sellRate),
  ].join('|');
}

function sortedWindowSignatures(windows: TimePeriodWindowInput[]): string[] {
  return windows.map(windowSignature).sort();
}

/** Date range plus both window sets. Season and plan names are deliberately excluded. */
function seasonSignature(season: TariffSeasonInput): string {
  const range = [
    season.fromMonth,
    season.fromDay ?? 'none',
    season.toMonth,
    season.toDay ?? 'none',
  ].join('-');
  return [
    range,
    `weekday:${sortedWindowSignatures(season.weekdayPeriods).join(';')}`,
    `weekend:${sortedWindowSignatures(season.weekendPeriods).join(';')}`,
  ].join('#');
}

function currenciesDiffer(opts: TeslaPlanMatchOptions | undefined): boolean {
  if (!opts?.pwusageCurrency || !opts.teslaCurrency) return false;
  return opts.pwusageCurrency.toUpperCase() !== opts.teslaCurrency.toUpperCase();
}

/**
 * True when Tesla would store the same plan PWUsage holds. Tesla's adjustments are applied to
 * PWUsage's side first. Seasons are compared as a set keyed by date range, so window and season
 * order and names do not matter.
 */
export function teslaPlansMatch(
  pwusage: TariffSeasonInput[],
  tesla: TariffSeasonInput[],
  opts?: TeslaPlanMatchOptions,
): boolean {
  if (currenciesDiffer(opts)) return false;

  const pwusageSignatures = applyTeslaAdjustments(pwusage).seasons.map(seasonSignature).sort();
  const teslaSignatures = tesla.map(seasonSignature).sort();
  if (pwusageSignatures.length !== teslaSignatures.length) return false;
  return pwusageSignatures.every((sig, i) => sig === teslaSignatures[i]);
}

const TESLA_CURRENCIES = ['USD', 'EUR', 'GBP'];
const TESLA_ALL_GROUP = 'ALL';
const MINUTES_PER_DAY = 1440;
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface TeslaSyncProblem {
  code: 'season_gap' | 'season_overlap' | 'season_name_conflict' | 'hour_gap' | 'hour_overlap' | 'label_rate_conflict' | 'currency';
  season?: string;
  period?: TariffPeriodName;
  message: string;
}

export interface TeslaPlanPayloadInput {
  name: string;
  seasons: TariffSeasonInput[];
}

/** Tesla's payload keeps one rate per period label within each season, so windows must agree. */
function labelRateConflicts(season: TariffSeasonInput): TeslaSyncProblem[] {
  const seen = new Map<TariffPeriodName, { buy: number; sell: number }>();
  const conflicts = new Map<TariffPeriodName, TeslaSyncProblem>();
  for (const window of [...season.weekdayPeriods, ...season.weekendPeriods]) {
    const rates = { buy: round5(window.buyRate), sell: round5(window.sellRate) };
    const previous = seen.get(window.touName);
    if (!previous) {
      seen.set(window.touName, rates);
    } else if (previous.buy !== rates.buy || previous.sell !== rates.sell) {
      conflicts.set(window.touName, {
        code: 'label_rate_conflict',
        season: season.name,
        period: window.touName,
        message: `${season.name} has more than one ${window.touName} rate. Tesla keeps one rate per period, so give every ${window.touName} window in ${season.name} the same buy and export rate.`,
      });
    }
  }
  return [...conflicts.values()];
}

function formatMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  const min = minute % 60;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Start and end (exclusive, minutes from midnight) of each run where `predicate` holds. */
function runsWhere(counts: number[], predicate: (count: number) => boolean): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start: number | null = null;
  for (let minute = 0; minute <= MINUTES_PER_DAY; minute++) {
    const hit = minute < MINUTES_PER_DAY && predicate(counts[minute]);
    if (hit && start === null) start = minute;
    if (!hit && start !== null) {
      runs.push([start, minute]);
      start = null;
    }
  }
  return runs;
}

/** Minute-by-minute coverage of one day type. A window ending at 00:00 runs to midnight. */
function coverageCounts(windows: TimePeriodWindowInput[]): number[] {
  const counts = new Array<number>(MINUTES_PER_DAY).fill(0);
  for (const window of windows) {
    const start = window.fromHour * 60 + window.fromMinute;
    let end = window.toHour * 60 + window.toMinute;
    if (end === 0 && start > 0) end = MINUTES_PER_DAY;
    if (start === end) continue;
    const spans: Array<[number, number]> = end > start
      ? [[start, end]]
      : [[start, MINUTES_PER_DAY], [0, end]];
    for (const [from, to] of spans) {
      for (let minute = from; minute < to; minute++) counts[minute]++;
    }
  }
  return counts;
}

function hourProblems(season: TariffSeasonInput): TeslaSyncProblem[] {
  const problems: TeslaSyncProblem[] = [];
  const dayTypes: Array<[string, TimePeriodWindowInput[]]> = [
    ['weekday', season.weekdayPeriods],
    ['weekend', season.weekendPeriods],
  ];
  for (const [dayType, windows] of dayTypes) {
    const counts = coverageCounts(windows);
    for (const [from, to] of runsWhere(counts, count => count === 0)) {
      problems.push({
        code: 'hour_gap',
        season: season.name,
        message: `${season.name} ${dayType} schedule has no period from ${formatMinute(from)} to ${formatMinute(to)}.`,
      });
    }
    for (const [from, to] of runsWhere(counts, count => count > 1)) {
      problems.push({
        code: 'hour_overlap',
        season: season.name,
        message: `${season.name} ${dayType} schedule has overlapping periods from ${formatMinute(from)} to ${formatMinute(to)}.`,
      });
    }
  }
  return problems;
}

/** Day-of-year index on a 366-day year, as tariff-timeline counts them (Feb 29 included). */
function dayOfYear(month: number, day: number): number {
  let offset = 0;
  for (let i = 0; i < month - 1; i++) offset += MONTH_MAX_DAYS[i];
  return offset + day - 1;
}

function dayLabel(index: number): string {
  let remaining = index;
  for (let month = 0; month < 12; month++) {
    if (remaining < MONTH_MAX_DAYS[month]) return `${MONTH_NAMES[month]} ${remaining + 1}`;
    remaining -= MONTH_MAX_DAYS[month];
  }
  return `${MONTH_NAMES[11]} 31`;
}

function seasonCoverage(seasons: TariffSeasonInput[]): TeslaSyncProblem[] {
  const owners = new Array<string | null>(366).fill(null);
  const problems: TeslaSyncProblem[] = [];
  const overlapPairs = new Set<string>();

  for (const season of seasons) {
    const start = dayOfYear(season.fromMonth, season.fromDay ?? 1);
    const end = dayOfYear(season.toMonth, season.toDay ?? MONTH_MAX_DAYS[season.toMonth - 1]);
    for (let day = start; ; day = (day + 1) % 366) {
      const owner = owners[day];
      if (owner !== null) {
        const pair = [owner, season.name].sort().join('\u0000');
        if (!overlapPairs.has(pair)) {
          overlapPairs.add(pair);
          problems.push({
            code: 'season_overlap',
            season: season.name,
            message: `${owner} and ${season.name} both cover ${dayLabel(day)}. Each day needs exactly one season.`,
          });
        }
      } else {
        owners[day] = season.name;
      }
      if (day === end) break;
    }
  }

  let gapStart: number | null = null;
  for (let day = 0; day <= 366; day++) {
    const uncovered = day < 366 && owners[day] === null;
    if (uncovered && gapStart === null) gapStart = day;
    if (!uncovered && gapStart !== null) {
      const from = dayLabel(gapStart);
      const to = dayLabel(day - 1);
      problems.push({
        code: 'season_gap',
        message: from === to
          ? `No season covers ${from}. Seasons must cover every day of the year.`
          : `No season covers ${from} through ${to}. Seasons must cover every day of the year.`,
      });
      gapStart = null;
    }
  }
  return problems;
}

/**
 * Tesla keys seasons, energy charges and sell charges by season name (case-sensitive), so two
 * seasons with one name would overwrite each other. The name `ALL` would overwrite Tesla's placeholder.
 */
function seasonNameProblems(seasons: TariffSeasonInput[]): TeslaSyncProblem[] {
  const counts = new Map<string, number>();
  for (const season of seasons) counts.set(season.name, (counts.get(season.name) ?? 0) + 1);
  const problems: TeslaSyncProblem[] = [];
  for (const [name, count] of counts) {
    if (name === TESLA_ALL_GROUP) {
      problems.push({
        code: 'season_name_conflict',
        season: name,
        message: `A season cannot be named ${TESLA_ALL_GROUP}. Tesla uses that name for its own placeholder, so rename this season.`,
      });
    } else if (count > 1) {
      problems.push({
        code: 'season_name_conflict',
        season: name,
        message: `${count} seasons are named ${name}. Tesla stores each season by its name, so give every season a different name.`,
      });
    }
  }
  return problems;
}

/**
 * Problems that would stop Tesla storing the plan as PWUsage describes it. Empty when the plan
 * is valid. Messages are shown to the owner as-is.
 */
export function validateForTesla(seasons: TariffSeasonInput[], currency: string): TeslaSyncProblem[] {
  const problems: TeslaSyncProblem[] = [];
  if (!TESLA_CURRENCIES.includes(currency.toUpperCase())) {
    problems.push({
      code: 'currency',
      message: `Tesla stores rates in USD, EUR or GBP. This plan uses ${currency}.`,
    });
  }
  problems.push(...seasonCoverage(seasons), ...seasonNameProblems(seasons));
  for (const season of seasons) {
    problems.push(...hourProblems(season), ...labelRateConflicts(season));
  }
  return problems;
}

/**
 * Tesla's `tariff_content_v2` for PWUsage's plan. Starts from a deep copy of `base` (Tesla's
 * freshly read tariff) and replaces the name, seasons and energy charges; the `ALL` placeholder
 * is kept. The rates written are PWUsage's raw rates: Tesla applies its own adjustments when it
 * stores them (teslaPlansMatch applies the same adjustments to the PWUsage side when comparing).
 * Callers run `validateForTesla` first: a label with two rates keeps the last one, and duplicate
 * season names would overwrite each other.
 */
export function buildTeslaTariff(base: TariffV2, plan: TeslaPlanPayloadInput): TariffV2 {
  const copy = structuredClone(base);
  const compiled = compileSeasonsToParsedTariff(plan.name, plan.seasons);

  const seasons: Record<string, Season> = {};
  const buyCharges: Record<string, EnergyChargeRates> = {};
  const sellCharges: Record<string, EnergyChargeRates> = {};

  for (const season of compiled.seasons) {
    const touPeriods: Record<string, SeasonPeriods> = {};
    const buyRates: Record<string, number> = {};
    const sellRates: Record<string, number> = {};
    for (const schedule of season.schedules) {
      if (!touPeriods[schedule.name]) touPeriods[schedule.name] = { periods: [] };
      touPeriods[schedule.name].periods.push({
        fromDayOfWeek: schedule.from_day_of_week,
        toDayOfWeek: schedule.to_day_of_week,
        fromHour: schedule.from_hour,
        fromMinute: schedule.from_minute,
        toHour: schedule.to_hour,
        toMinute: schedule.to_minute,
      });
      buyRates[schedule.name] = round5(schedule.buy_rate);
      sellRates[schedule.name] = round5(schedule.sell_rate);
    }
    seasons[season.name] = {
      fromDay: season.from_day,
      toDay: season.to_day,
      fromMonth: season.from_month,
      toMonth: season.to_month,
      tou_periods: touPeriods,
    };
    buyCharges[season.name] = { rates: buyRates };
    sellCharges[season.name] = { rates: sellRates };
  }

  const keepAll = (charges: Record<string, EnergyChargeRates>): Record<string, EnergyChargeRates> =>
    charges[TESLA_ALL_GROUP] ? { [TESLA_ALL_GROUP]: structuredClone(charges[TESLA_ALL_GROUP]) } : {};

  copy.name = plan.name;
  copy.seasons = structuredClone(seasons);
  copy.energy_charges = { ...keepAll(base.energy_charges), ...buyCharges };
  const baseSell = base.sell_tariff;
  copy.sell_tariff = {
    name: baseSell?.name ?? plan.name,
    utility: baseSell?.utility ?? base.utility,
    ...(structuredClone(baseSell ?? {}) as Partial<TariffV2['sell_tariff']>),
    seasons: structuredClone(seasons),
    energy_charges: {
      ...(baseSell ? keepAll(baseSell.energy_charges) : { [TESLA_ALL_GROUP]: { rates: { [TESLA_ALL_GROUP]: 0 } } }),
      ...sellCharges,
    },
  };
  return copy;
}

/** PWUsage's season shape for Tesla's stored `tariff_content_v2`: the importer's parse, then the same decompile a saved plan uses. */
export function seasonsFromTeslaContent(content: TariffV2): TariffSeasonInput[] {
  const parsed = parseTariffContent(content, 'Site');
  const tariff: Tariff = {
    id: 0,
    site_id: '',
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
