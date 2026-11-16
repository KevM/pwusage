import type { TariffSeasonInput } from '../tariff-contract';
import { urdbRateToSeasons, type ConvertContext } from './convert';
import type { UrdbApi } from './estimate-job';
import { newerRevision, urdbStartDate, walkSupersedes } from './match';
import type { UrdbRate } from './types';

export interface HistoryPeriodInput { label: string; from: string; to: string | null }
export interface ExpandedRevision { label: string; revisionStart: string; from: string; to: string | null; name: string; seasons: TariffSeasonInput[] }
// The message is owner-facing.
export class HistoryPeriodError extends Error {}
const MAX_WALK_STEPS = 40;

export async function expandHistoryPeriod(period: HistoryPeriodInput, ctx: { api: UrdbApi; utilityName: string; timeZone: string; today: string; convert: ConvertContext }): Promise<ExpandedRevision[]> {
  const fetchByLabel = (label: string) => ctx.api.rateByLabel(label);
  const chosen = await fetchByLabel(period.label);
  if (!chosen || chosen.utility.trim().toLowerCase() !== ctx.utilityName.trim().toLowerCase()) throw new HistoryPeriodError('That rate plan isn’t listed for your utility.');
  const inEffect = await ctx.api.ratesEffectiveOn(ctx.utilityName, period.to ?? ctx.today, ctx.timeZone);
  const newest: UrdbRate = (await newerRevision(chosen, inEffect, fetchByLabel)) ?? chosen;
  const walked = await walkSupersedes(newest, fetchByLabel, { endBefore: null, maxSteps: MAX_WALK_STEPS, timeZone: ctx.timeZone });
  // The owner says they were on this plan: the oldest known prices are the best guess before them.
  const spans = walked.map((span, index) => index === 0 && span.effectiveFrom > period.from ? { ...span, effectiveFrom: period.from } : span)
    .filter(span => (period.to === null || span.effectiveFrom <= period.to) && (span.effectiveTo === null || span.effectiveTo >= period.from))
    .map(span => ({ ...span, effectiveFrom: span.effectiveFrom < period.from ? period.from : span.effectiveFrom, effectiveTo: period.to !== null && (span.effectiveTo === null || span.effectiveTo > period.to) ? period.to : span.effectiveTo }));
  const converted = spans.map(span => urdbRateToSeasons(span.rate, ctx.convert));
  const usable = (index: number) => { const result = converted[index]; return result.ok ? result : null; };
  const revisions = spans.map((span, index) => {
    let source = usable(index);
    for (let next = index + 1; !source && next < spans.length; next++) source = usable(next);
    for (let older = index - 1; !source && older >= 0; older--) source = usable(older);
    return source && { label: span.rate.label, revisionStart: urdbStartDate(span.rate) ?? span.effectiveFrom, from: span.effectiveFrom, to: span.effectiveTo, name: source.name, seasons: source.seasons };
  });
  if (revisions.some(revision => !revision)) throw new HistoryPeriodError(`We couldn’t read the rates for ${chosen.name}. Add this rate plan in Rate Plans.`);
  return revisions as ExpandedRevision[];
}
