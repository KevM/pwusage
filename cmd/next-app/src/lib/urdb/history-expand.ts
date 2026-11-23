import type { TariffSeasonInput } from '../tariff-contract';
import { isFixedRate, urdbRateToSeasons, type ConvertContext } from './convert';
import { followedFixedRevisions, referenceDesiredSpans, type UrdbApi } from './estimate-job';
import { newerRevision, urdbStartDate, walkSupersedes } from './match';
import type { UrdbRate } from './types';
import { normalizeUtilityName } from './utility-lookup';

export interface HistoryPeriodInput { label: string; from: string; to: string | null }
export interface ExpandedRevision { label: string; revisionStart: string; from: string; to: string | null; name: string; seasons: TariffSeasonInput[] }
// The message is owner-facing.
export class HistoryPeriodError extends Error {}
const MAX_WALK_STEPS = 40;
type ExpandContext = { api: Pick<UrdbApi, 'ratesEffectiveOn' | 'rateByLabel'>; utilityName: string; timeZone: string; today: string; convert: ConvertContext };

export async function expandHistoryPeriod(period: HistoryPeriodInput, ctx: ExpandContext): Promise<Array<ExpandedRevision & { pricingRate: UrdbRate }>> {
  const fetchByLabel = (label: string) => ctx.api.rateByLabel(label);
  const [chosen, inEffect] = await Promise.all([fetchByLabel(period.label), ctx.api.ratesEffectiveOn(ctx.utilityName, period.to ?? ctx.today, ctx.timeZone)]);
  // URDB lists some utilities under an alias ("We energies") whose rates are filed under another name.
  const utilityNames = new Set([ctx.utilityName, ...inEffect.map(rate => rate.utility)].map(normalizeUtilityName));
  if (!chosen || !utilityNames.has(normalizeUtilityName(chosen.utility))) throw new HistoryPeriodError('That rate plan isn’t listed for your utility.');
  const newest: UrdbRate = (await newerRevision(chosen, inEffect, fetchByLabel)) ?? chosen;
  const walked = await walkSupersedes(newest, fetchByLabel, { endBefore: null, maxSteps: MAX_WALK_STEPS, timeZone: ctx.timeZone });
  // The owner says they were on this plan: the oldest known prices are the best guess before them.
  const spans = walked.map((span, index) => index === 0 && span.effectiveFrom > period.from ? { ...span, effectiveFrom: period.from } : span)
    .filter(span => (period.to === null || span.effectiveFrom <= period.to) && (span.effectiveTo === null || span.effectiveTo >= period.from))
    .map(span => ({ ...span, effectiveFrom: span.effectiveFrom < period.from ? period.from : span.effectiveFrom, effectiveTo: period.to !== null && (span.effectiveTo === null || span.effectiveTo > period.to) ? period.to : span.effectiveTo }));
  const converted = spans.map(span => urdbRateToSeasons(span.rate, ctx.convert));
  const usable = (index: number) => {
    const result = converted[index];
    return result.ok ? { ...result, pricingRate: spans[index].rate } : null;
  };
  const revisions = spans.map((span, index) => {
    let source = usable(index);
    for (let next = index + 1; !source && next < spans.length; next++) source = usable(next);
    for (let older = index - 1; !source && older >= 0; older--) source = usable(older);
    return source && { label: span.rate.label, revisionStart: urdbStartDate(span.rate) ?? span.effectiveFrom, from: span.effectiveFrom, to: span.effectiveTo, name: source.name, seasons: source.seasons, pricingRate: source.pricingRate };
  });
  if (revisions.some(revision => !revision)) throw new HistoryPeriodError(`We couldn’t read the rates for ${chosen.name}. Add this rate plan in Rate Plans.`);
  return revisions.filter(revision => revision !== null);
}

/**
 * Expands an open-ended fixed comparison choice using the same revision policy as `runUrdbEstimatesForSite`:
 * only convertible fixed revisions are kept, with no price borrowing across unreadable filings, so the initial
 * save lays the exact spans the background refresh will maintain.
 */
export async function expandFollowedHistoryPeriod(period: { label: string; from: string }, ctx: ExpandContext): Promise<ExpandedRevision[]> {
  const fetchByLabel = (label: string) => ctx.api.rateByLabel(label);
  const [chosen, inEffect] = await Promise.all([fetchByLabel(period.label), ctx.api.ratesEffectiveOn(ctx.utilityName, ctx.today, ctx.timeZone)]);
  const utilityNames = new Set([ctx.utilityName, ...inEffect.map(rate => rate.utility)].map(normalizeUtilityName));
  if (!chosen || !utilityNames.has(normalizeUtilityName(chosen.utility))) throw new HistoryPeriodError('That rate plan isn’t listed for your utility.');
  if (!isFixedRate(chosen)) throw new HistoryPeriodError('Choose a fixed rate plan.');
  const followed = await followedFixedRevisions(chosen, inEffect, fetchByLabel, ctx.timeZone);
  const spans = referenceDesiredSpans([], followed, period.from);
  const revisions = spans.flatMap(span => {
    const converted = urdbRateToSeasons(span.rate, ctx.convert);
    if (!converted.ok) return [];
    return [{
      label: span.rate.label,
      revisionStart: urdbStartDate(span.rate) ?? span.effectiveFrom,
      from: span.effectiveFrom,
      to: span.effectiveTo,
      name: converted.name,
      seasons: converted.seasons,
    }];
  });
  if (!revisions.length) throw new HistoryPeriodError(`We couldn’t read the rates for ${chosen.name}. Add this rate plan in Rate Plans.`);
  return revisions;
}
