import type { TariffPeriodName, TariffSeasonInput, TimePeriodWindowInput } from './tariff-contract';

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
