import type { Tariff, TariffStartSource } from '../db-types';
import { Schedule } from '../schedule';
import { addCalendarDays } from '../tariff-timeline';
import { isFixedRate, urdbBuyRateAt } from './convert';
import type { UrdbRate } from './types';
export interface RevisionSpan { rate: UrdbRate; effectiveFrom: string; effectiveTo: string | null }
// URDB start dates are calendar days, but records store them anywhere from an hour before
// UTC midnight (23:00Z) to a US local midnight (up to 08:00Z). Shift 3 hours, then take the UTC day.
export function urdbStartDate(rate: UrdbRate): string | null {
  if (rate.startdate === undefined || !Number.isFinite(rate.startdate)) return null;
  const date = new Date((rate.startdate + 10_800) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
const dateOf = urdbStartDate;
export function teslaMatchesUrdb(tesla: Tariff, rate: UrdbRate): boolean {
  const schedule = new Schedule([tesla], 'UTC');
  return [true, false].some(withAdj => {
    for (let month = 1; month <= 12; month++) for (const weekend of [false, true]) for (let hour = 0; hour < 24; hour++) {
      const period = schedule.getTariffPeriodByComponents(month, 15, hour, weekend ? 6 : 1, undefined, undefined, 30);
      const teslaRate = period?.schedule.buy_rate ?? period?.season.buy_rate;
      const urdbRate = urdbBuyRateAt(rate, month, weekend, hour, withAdj);
      if (teslaRate == null || urdbRate === null || Math.abs(teslaRate - urdbRate) > 0.005 + 1e-10) return false;
    }
    return true;
  });
}
function overlapScore(tesla: Tariff, rate: UrdbRate): number {
  const tokens = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const wanted = tokens(`${tesla.plan_name ?? ''} ${tesla.plan_code ?? ''}`);
  return [...tokens(rate.name)].filter(token => wanted.has(token)).length;
}
// Same-priced single- and three-phase revisions are common; residential services are single-phase.
const threePhase = (rate: UrdbRate) => Number(/three[- ]phase|3[- ]phase/i.test(rate.name));
export function pickTeslaMatch(tesla: Tariff, candidates: UrdbRate[]): UrdbRate | null {
  return candidates.filter(rate => teslaMatchesUrdb(tesla, rate)).sort((a, b) => overlapScore(tesla, b) - overlapScore(tesla, a) || threePhase(a) - threePhase(b) || (b.startdate ?? 0) - (a.startdate ?? 0) || b.label.localeCompare(a.label))[0] ?? null;
}
function spans(rates: UrdbRate[], endBefore: string | null): RevisionSpan[] {
  const byDate = new Map<string, UrdbRate>();
  // Input order is newest-chain-first: prefer that item for duplicate dates.
  for (const rate of rates) {
    const date = dateOf(rate);
    if (date && !byDate.has(date)) byDate.set(date, rate);
  }
  const ordered = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  return ordered.map(([effectiveFrom, rate], index) => ({ rate, effectiveFrom, effectiveTo: index + 1 < ordered.length ? addCalendarDays(ordered[index + 1][0], -1) : endBefore ? addCalendarDays(endBefore, -1) : null })).filter(span => span.effectiveTo === null || span.effectiveFrom <= span.effectiveTo);
}
export async function walkSupersedes(start: UrdbRate, fetchByLabel: (label: string) => Promise<UrdbRate | null>, opts: { endBefore: string | null; maxSteps: number; timeZone: string }): Promise<RevisionSpan[]> {
  const rates: UrdbRate[] = [];
  const seen = new Set<string>();
  let rate: UrdbRate | null = start;
  while (rate && rates.length < opts.maxSteps && !seen.has(rate.label)) {
    seen.add(rate.label); rates.push(rate);
    rate = rate.supersedes && rates.length < opts.maxSteps ? await fetchByLabel(rate.supersedes) : null;
  }
  return spans(rates, opts.endBefore);
}
export function referenceSpans(defaults: UrdbRate[], timeZone: string): RevisionSpan[] {
  void timeZone;
  const fixed = defaults.filter(isFixedRate);
  const ordered = [...fixed].sort((a, b) => (b.startdate ?? 0) - (a.startdate ?? 0) || b.label.localeCompare(a.label));
  const byLabel = new Map(fixed.map(rate => [rate.label, rate]));
  const lineage = new Set<string>();
  let current: UrdbRate | undefined = ordered[0];
  while (current && !lineage.has(current.label)) {
    lineage.add(current.label);
    current = current.supersedes ? byLabel.get(current.supersedes) : undefined;
  }
  const sorted = ordered.sort((a, b) => Number(lineage.has(b.label)) - Number(lineage.has(a.label)) || b.label.localeCompare(a.label));
  return spans(sorted, null);
}
export async function newerRevision(matched: UrdbRate, today: UrdbRate[], fetchByLabel: (label: string) => Promise<UrdbRate | null>): Promise<UrdbRate | null> {
  for (const candidate of [...today].sort((a, b) => (b.startdate ?? 0) - (a.startdate ?? 0))) {
    if ((candidate.startdate ?? 0) <= (matched.startdate ?? 0)) continue;
    let rate: UrdbRate | null = candidate;
    const seen = new Set<string>();
    for (let i = 0; i < 10 && rate?.supersedes && !seen.has(rate.label); i++) {
      seen.add(rate.label);
      if (rate.supersedes === matched.label) return candidate;
      rate = await fetchByLabel(rate.supersedes);
    }
  }
  return null;
}
export function anchorStart(input: { matched: UrdbRate | null; firstSeen: string; isFirstVersion: boolean; currentSpanStart: string; ownerDated: boolean; timeZone: string }): { startDate: string; startSource: TariffStartSource } | null {
  if (input.ownerDated) return null;
  const matchedDate = input.matched && dateOf(input.matched);
  if (matchedDate) return { startDate: matchedDate, startSource: 'urdb' };
  if (!input.isFirstVersion) return { startDate: input.firstSeen, startSource: 'tesla_first_seen' };
  const jan = `${input.firstSeen.slice(0, 4)}-01-01`;
  return input.currentSpanStart < jan ? { startDate: input.currentSpanStart, startSource: 'history_start' } : { startDate: jan, startSource: 'assumed_jan_1' };
}
