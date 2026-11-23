import { pool } from '../db';
import { IncompleteTariffAttributionError } from '../billing-availability';
import { SiteRepo } from '../site-repo';
import { withIoDeadline } from '../io-deadline';
import type { SiteUtilityRow, SiteUtilityStatus, Tariff } from '../db-types';
import { createEnergyRepo } from '../energy-repo-factory';
import { checkIoDeadline } from '../io-deadline';
import { logEvent } from '../observability';
import { enqueueReattributionOnClient } from '../tariff-reattribution-queue';
import {
  applyEstimatesOnClient,
  bumpSiteTimelineRevisionOnClient,
  clearUnprotectedUrdbSourcesOnClient,
  hydrateTariffs,
  insertTariffGraph,
  loadExistingSpans,
  pickActivePeriodForDate,
} from '../tariff-timeline-repo';
import { addCalendarDays, compileSeasonsToParsedTariff, isProtectedSpan, siteLocalDateString, validateTariffPlanInput } from '../tariff-timeline';
import { buildDefaultTariff, parseTariffContent, tariffContentHash, type ParsedTariff } from '../importer/tariff-parser';
import type { TariffV2 } from '../tesla-client';
import { layoutTimeline } from '../tariff-estimates';
import * as client from './client';
import { isFixedRate, urdbRateToSeasons } from './convert';
import { anchorStart, newerRevision, pickTeslaMatch, referenceSpans, urdbStartDate, walkSupersedes, type RevisionSpan } from './match';
import { normalizeUtilityName, resolveUtility } from './utility-lookup';
import { deriveRatePlanEligibility, US_ELIGIBLE_COUNTRY_LIST } from '../rate-plan-eligibility';
import type { UrdbRate } from './types';
import type { TariffSeasonInput } from '../tariff-contract';

export interface UrdbApi { ratesEffectiveOn: typeof client.ratesEffectiveOn; rateByLabel: typeof client.rateByLabel; defaultRates: typeof client.defaultRates; utilityNames: typeof client.utilityNames }
type Snapshot = { site: { id: string; utility: string | null; grid_utility: string | null; timezone: string; rate_country: string | null; history_start: string | null; tariff_content: TariffV2 | null; site_name: string | null }; utility: SiteUtilityRow | undefined; spans: Awaited<ReturnType<typeof loadExistingSpans>>; tariffs: Tariff[]; allTariffs: Tariff[]; sources: Array<{ tariff_id: number; role: string; urdb_label: string | null; content_hash: string | null }> };
type Anchor = { tariffId: number; startDate: string; startSource: string; label: string | null; newer: UrdbRate | null };
type Converted = { span: RevisionSpan; seasons: TariffSeasonInput[]; name: string; role: 'estimated_actual' | 'estimated_reference' };
type PlanBackfill = { tariffId: number; name: string | null; code: string | null };
type Preview = { planBackfill: PlanBackfill | null; matchOutcomes: Array<'matched' | 'no_match' | 'unconvertible' | 'no_utility'>; fallbackTariffIds: number[]; ownerPicked: boolean; status: SiteUtilityStatus; utilityName: string | null; anchors: Anchor[]; actual: Converted[]; reference: Converted[]; changed: Array<{ from: string; to: string | null }> };
const MAX_REVISIONS = 80;
// The owner's followed fixed plan owns the comparison from `followedFrom`; the utility defaults keep the days before it.
export function referenceDesiredSpans(defaults: RevisionSpan[], followed: RevisionSpan[], followedFrom: string | null): RevisionSpan[] {
  if (!followedFrom) return defaults;
  const before = defaults
    .filter(span => span.effectiveFrom < followedFrom)
    .map(span => span.effectiveTo === null || span.effectiveTo >= followedFrom ? { ...span, effectiveTo: addCalendarDays(followedFrom, -1) } : span);
  const from = followed
    .filter(span => span.effectiveTo === null || span.effectiveTo >= followedFrom)
    .map(span => span.effectiveFrom < followedFrom ? { ...span, effectiveFrom: followedFrom } : span);
  // The owner's range may start before the label's oldest known revision; that revision applies back to it.
  const oldest = from.reduce<number>((best, span, index) => best < 0 || span.effectiveFrom < from[best].effectiveFrom ? index : best, -1);
  if (oldest >= 0 && from[oldest].effectiveFrom > followedFrom) from[oldest] = { ...from[oldest], effectiveFrom: followedFrom };
  // Keep a single continuous span when the default and followed plan share a revision at the boundary.
  return [...before, ...from].reduce<RevisionSpan[]>((merged, span) => {
    const last = merged.at(-1);
    if (last && last.rate.label === span.rate.label && last.effectiveTo !== null && addCalendarDays(last.effectiveTo, 1) === span.effectiveFrom) merged[merged.length - 1] = { ...last, effectiveTo: span.effectiveTo };
    else merged.push(span);
    return merged;
  }, []);
}
// URDB lists some utilities under an alias ("We energies") whose rates it files under another name
// ("Wisconsin Electric Power Co"), so accept the names of the rates URDB lists for the stored utility.
export function ownerPlanMatchesUtility(selected: UrdbRate | null, utilityName: string, inEffect: UrdbRate[]): boolean {
  if (!selected) return false;
  const names = new Set([utilityName, ...inEffect.map(rate => rate.utility)].map(normalizeUtilityName));
  return names.has(normalizeUtilityName(selected.utility));
}
async function snapshot(siteId: string): Promise<Snapshot> {
  const site = (await pool.query<Snapshot['site']>(`SELECT s.id, s.utility, s.json ->> 'utility' AS grid_utility, COALESCE(s.timezone, 'UTC') AS timezone, s.rate_country, s.json -> 'tariff_content_v2' AS tariff_content, s.json ->> 'site_name' AS site_name, (SELECT min(day_start AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date::text FROM "EnergyDayArchive" WHERE site_id = s.id) AS history_start FROM "Site" s WHERE s.id = $1`, [siteId])).rows[0];
  if (!site) throw new Error('Site not found');
  // pg returns date columns as Date objects, so read the reference day as text under its own alias.
  const utilityRow = (await pool.query<SiteUtilityRow & { urdb_reference_from_text: string | null }>('SELECT *, urdb_reference_from::text AS urdb_reference_from_text FROM "SiteUtility" WHERE site_id = $1', [siteId])).rows[0];
  const utility: SiteUtilityRow | undefined = utilityRow && { ...utilityRow, urdb_reference_from: utilityRow.urdb_reference_from_text };
  const connection = await pool.connect();
  try {
    const spans = await loadExistingSpans(connection, siteId);
    const versions = (await connection.query<{ id: number; updated: Date }>(`SELECT id, updated AT TIME ZONE 'UTC' AS updated FROM "Tariff" WHERE site_id = $1 AND source = 'tesla' ORDER BY updated, id`, [siteId])).rows;
    const ids = versions.map(row => Number(row.id));
    const map = await hydrateTariffs(connection, [...new Set([...ids, ...spans.map(span => span.tariffId)])]);
    const sources = (await connection.query<Snapshot['sources'][number]>(`SELECT u.tariff_id, u.role, u.urdb_label, t.content_hash FROM "TariffUrdbSource" u JOIN "Tariff" t ON t.id = u.tariff_id WHERE u.site_id = $1`, [siteId])).rows;
    return { site, utility, spans, tariffs: versions.flatMap(version => { const tariff = map.get(Number(version.id)); return tariff ? [{ ...tariff, updated: version.updated }] : []; }), allTariffs: [...map.values()], sources };
  } finally { connection.release(); }
}
export function averageSell(tariff: Tariff | undefined): number {
  const rates = tariff?.seasons?.flatMap(season => season.schedules?.map(schedule => schedule.sell_rate ?? season.sell_rate) ?? [season.sell_rate]) ?? [];
  return rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
}
// Rows stored before content hashes existed hash their hydrated graph; nulls there are absent fields in a parse.
function storedTariffHash(tariff: Tariff): string {
  return tariff.content_hash ?? tariffContentHash(JSON.parse(JSON.stringify({ name: tariff.name, seasons: tariff.seasons ?? [] }, (_key, value) => value === null ? undefined : value)) as ParsedTariff);
}
// Tesla's plan name and code exist only for the current plan in Site.json, so fill them on the
// latest Tesla version when it is that plan (versions synced before the columns existed have none).
function planBackfillFor(latest: Tariff | undefined, site: Snapshot['site']): PlanBackfill | null {
  const content = site.tariff_content;
  if (!latest || latest.plan_name != null || latest.plan_code != null || !content || (!content.name && !content.code)) return null;
  let parsedHash: string;
  try { parsedHash = tariffContentHash(parseTariffContent(content, site.site_name ?? 'Utility Tariff')); } catch { return null; }
  return storedTariffHash(latest) === parsedHash ? { tariffId: latest.id, name: content.name ?? null, code: content.code ?? null } : null;
}
export async function monthlyUsage(siteId: string, timezone: string, now: Date): Promise<number | null> {
  // History with incomplete tariff attribution cannot provide a trustworthy aggregate yet.
  let rows;
  try { rows = await createEnergyRepo(timezone).getCycleAggregates(siteId, new Date(now.getTime() - 365 * 86400000), now, timezone); }
  catch (error) { if (error instanceof IncompleteTariffAttributionError) return null; throw error; }
  const months = new Map<string, number>();
  for (const row of rows) { const month = siteLocalDateString(row.day, timezone).slice(0, 7); months.set(month, (months.get(month) ?? 0) + Number(row.load_power) / 1000); }
  const values = [...months.values()].sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
async function buildPreview(snapshotData: Snapshot, api: UrdbApi, now: Date): Promise<Preview> {
  const { site, utility, spans, allTariffs, sources } = snapshotData;
  const fallbackHash = tariffContentHash(buildDefaultTariff('Default Rate'));
  const fallbackTariffIds = snapshotData.tariffs.filter(tariff => tariff.content_hash === fallbackHash).map(tariff => tariff.id);
  const unfilled = snapshotData.tariffs.filter(tariff => tariff.content_hash !== fallbackHash);
  const planBackfill = planBackfillFor(unfilled.at(-1), site);
  const tariffs = planBackfill ? unfilled.map(tariff => tariff.id === planBackfill.tariffId ? { ...tariff, plan_name: planBackfill.name, plan_code: planBackfill.code } : tariff) : unfilled;
  const empty = (status: SiteUtilityStatus, utilityName: string | null): Preview => ({ planBackfill, status, utilityName, anchors: [], actual: [], reference: [], changed: [], fallbackTariffIds, ownerPicked: false, matchOutcomes: tariffs.map(() => 'no_utility') });
  if (utility?.choice === 'skipped' || deriveRatePlanEligibility(site.rate_country) !== 'us') {
    return { ...empty('ready', null), changed: layoutTimeline(spans, [], []).changed };
  }
  const names = await api.utilityNames(); checkIoDeadline();
  const utilityName = utility?.choice === 'owner' ? utility.urdb_utility : resolveUtility(site.utility, names, site.grid_utility);
  if (!utilityName) return empty('needs_utility', null);
  const today = siteLocalDateString(now, site.timezone);
  let inEffectToday: Promise<UrdbRate[]> | undefined;
  const ratesToday = () => (inEffectToday ??= api.ratesEffectiveOn(utilityName, today, site.timezone));
  const matches: Array<UrdbRate | null> = [];
  const anchors: Anchor[] = [];
  // Earlier versions can own no span (the historic backfill spanned only the current version, and
  // owner plans can replace a version entirely). They still price days, so match them all, and treat
  // the first version that owns a span as the first version.
  const firstSpanned = tariffs.findIndex(tariff => spans.some(span => span.tariffId === tariff.id));
  for (const [index, tariff] of tariffs.entries()) {
    const firstSeen = siteLocalDateString(new Date(tariff.updated), site.timezone);
    const matched = pickTeslaMatch(tariff, await api.ratesEffectiveOn(utilityName, firstSeen, site.timezone));
    matches.push(matched);
    const ownedSpan = spans.find(span => span.tariffId === tariff.id);
    if (!ownedSpan) continue;
    const anchor = anchorStart({ matched, firstSeen, isFirstVersion: index === firstSpanned, currentSpanStart: ownedSpan.effectiveFrom, ownerDated: isProtectedSpan(ownedSpan), timeZone: site.timezone });
    if (anchor) anchors.push({ tariffId: tariff.id, ...anchor, label: matched?.label ?? null, newer: null });
  }
  if (matches.at(-1)) {
    const latest = matches.at(-1) as UrdbRate;
    const newer = await newerRevision(latest, await ratesToday(), api.rateByLabel);
    const anchor = anchors.find(item => item.tariffId === tariffs.at(-1)?.id);
    if (anchor) anchor.newer = newer;
  }
  const startIndex = matches.findIndex(Boolean);
  let start = startIndex >= 0 ? matches[startIndex] : null;
  // Owner plans added after a pick only take their own days: layout keeps them and the picked
  // chain still fills the rest, so the pick applies whether or not manual plans exist.
  if (!tariffs.length && utility?.urdb_plan_label) {
    const [selected, inEffect] = await Promise.all([api.rateByLabel(utility.urdb_plan_label), ratesToday()]);
    if (ownerPlanMatchesUtility(selected, utilityName, inEffect)) start = selected;
  }
  // Keep the matched revision itself open-ended: the Tesla span cannot always move back to its start
  // (owner-dated, or a manual plan in between), and layout gives Tesla and manual spans precedence.
  let actualSpans = start ? await walkSupersedes(start, api.rateByLabel, { endBefore: null, maxSteps: MAX_REVISIONS, timeZone: site.timezone }) : [];
  if (site.history_start) actualSpans = actualSpans.filter(span => span.effectiveTo === null || span.effectiveTo >= site.history_start!).map(span => ({ ...span, effectiveFrom: span.effectiveFrom < site.history_start! ? site.history_start! : span.effectiveFrom }));
  const defaults = referenceSpans(await api.defaultRates(utilityName), site.timezone).slice(-MAX_REVISIONS);
  // Follow the owner's chosen fixed plan through the revisions that replaced it, like the Tesla plan chain.
  // The followed range stays uncovered when the plan cannot be fetched: never lay the defaults over the owner's choice.
  let referencePlan = defaults;
  if (utility?.urdb_reference_label && utility.urdb_reference_from) {
    const chosen = await api.rateByLabel(utility.urdb_reference_label);
    let followed: RevisionSpan[] = [];
    if (chosen) {
      const newest = await newerRevision(chosen, await ratesToday(), api.rateByLabel) ?? chosen;
      followed = (await walkSupersedes(newest, api.rateByLabel, { endBefore: null, maxSteps: MAX_REVISIONS, timeZone: site.timezone })).filter(span => isFixedRate(span.rate));
    }
    referencePlan = referenceDesiredSpans(defaults, followed, utility.urdb_reference_from);
  }
  const usage = await monthlyUsage(site.id, site.timezone, now);
  function convert(span: RevisionSpan, role: Converted['role'], sell: number): Converted | null {
    const result = urdbRateToSeasons(span.rate, { medianMonthlyKwh: usage, fallbackSellRate: sell });
    if (!result.ok) return null;
    try { validateTariffPlanInput({ name: result.name, effectiveFrom: '2020-01-01', effectiveTo: null, seasons: result.seasons }, today); }
    catch { return null; }
    return { span, role, name: result.name, seasons: result.seasons };
  }
  // Stop at an unconvertible revision so the chain does not imply prices beyond it.
  const actual: Converted[] = [];
  for (const span of [...actualSpans].reverse()) { const value = convert(span, 'estimated_actual', averageSell(tariffs[startIndex] ?? tariffs[0])); if (!value) break; actual.unshift(value); }
  const desired = actual.map((value, index) => {
    const hash = tariffContentHash(compileSeasonsToParsedTariff(value.name, value.seasons));
    const previous = sources.find(source => source.role === value.role && source.urdb_label === value.span.rate.label && source.content_hash === hash);
    return { tariffId: previous ? Number(previous.tariff_id) : -1 - index, effectiveFrom: value.span.effectiveFrom, effectiveTo: value.span.effectiveTo };
  });
  const ownerPicked = !tariffs.length && !!start && !!utility?.urdb_plan_label;
  const previewSpans = ownerPicked ? spans.flatMap(row => {
    if (row.source !== 'tesla' || isProtectedSpan(row) || !fallbackTariffIds.includes(row.tariffId)) return [row];
    let parts = [{ from: row.effectiveFrom, to: row.effectiveTo }];
    for (const estimate of actual) parts = parts.flatMap(part => {
      const startDate = estimate.span.effectiveFrom;
      const finish = estimate.span.effectiveTo;
      if ((part.to !== null && part.to < startDate) || (finish !== null && finish < part.from)) return [part];
      const remaining: typeof parts = [];
      if (part.from < startDate) remaining.push({ from: part.from, to: addCalendarDays(startDate, -1) });
      if (finish !== null && (part.to === null || part.to > finish)) remaining.push({ from: addCalendarDays(finish, 1), to: part.to });
      return remaining;
    });
    return parts.map((part, index) => ({ ...row, id: row.id * 1000 + index, effectiveFrom: part.from, effectiveTo: part.to }));
  }) : spans;
  const layout = layoutTimeline(previewSpans, anchors, desired);
  const projected = [
    ...previewSpans.filter(row => !layout.deleteIds.includes(row.id)).map(row => ({ ...row, periodId: row.id })),
    ...layout.inserts.map((row, index) => ({ ...row, periodId: -1 - index })),
  ];
  const reference = referencePlan.flatMap(span => {
    const covering = pickActivePeriodForDate(projected, span.effectiveFrom);
    let sell = averageSell(allTariffs.find(tariff => tariff.id === covering?.tariffId));
    if (covering && covering.tariffId < 0) {
      const estimate = actual[-1 - covering.tariffId];
      const schedules = estimate ? compileSeasonsToParsedTariff(estimate.name, estimate.seasons).seasons.flatMap(season => season.schedules) : [];
      if (schedules.length) sell = schedules.reduce((sum, schedule) => sum + schedule.sell_rate, 0) / schedules.length;
    }
    const result = convert(span, 'estimated_reference', sell);
    return result ? [result] : [];
  });
  const changed = layout.changed;
  const status = !tariffs.length && !spans.some(span => isProtectedSpan(span)) && !start ? 'needs_plan' : 'ready';
  const matchOutcomes = matches.map((match, index) => !match ? 'no_match' as const : convert({ rate: match, effectiveFrom: today, effectiveTo: null }, 'estimated_actual', averageSell(tariffs[index])) ? 'matched' as const : 'unconvertible' as const);
  return { planBackfill, status, utilityName, anchors, actual, reference, changed, fallbackTariffIds, ownerPicked, matchOutcomes };
}
export async function previewUrdbEstimatesForSite(siteId: string, api: UrdbApi, now: Date): Promise<Preview> {
  return buildPreview(await snapshot(siteId), api, now);
}
export async function runUrdbEstimatesForSite(siteId: string, api: UrdbApi, now: Date): Promise<{ status: SiteUtilityStatus; changedDays: number }> {
  const connection = await pool.connect();
  let claim = '';
  try {
    await connection.query('BEGIN');
    const site = await connection.query('SELECT id FROM "Site" WHERE id = $1 AND orphaned_at IS NULL FOR UPDATE', [siteId]);
    if (!site.rowCount) throw new Error('Site not found');
    const claimed = await connection.query<{ claim: string }>(`INSERT INTO "SiteUtility" (site_id, choice, status, updated_at) VALUES ($1, 'auto', 'running', clock_timestamp()) ON CONFLICT (site_id) DO UPDATE SET status = 'running', updated_at = clock_timestamp() WHERE "SiteUtility".status <> 'running' OR "SiteUtility".updated_at < now() - interval '5 minutes' RETURNING updated_at::text AS claim`, [siteId]);
    if (!claimed.rows[0]) { await connection.query('ROLLBACK'); return { status: 'running', changedDays: 0 }; }
    claim = claimed.rows[0].claim;
    await connection.query('COMMIT');
  } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
  try {
    const effective = new Map<string, Promise<UrdbRate[]>>();
    const labels = new Map<string, Promise<UrdbRate | null>>();
    const memoApi: UrdbApi = {
      ...api,
      ratesEffectiveOn: (utility, date, zone) => {
        const key = JSON.stringify([utility, date, zone]);
        let value = effective.get(key);
        if (!value) { value = api.ratesEffectiveOn(utility, date, zone); effective.set(key, value); }
        return value;
      },
      rateByLabel: label => {
        let value = labels.get(label);
        if (!value) { value = api.rateByLabel(label); labels.set(label, value); }
        return value;
      },
    };
    const preview = await previewUrdbEstimatesForSite(siteId, memoApi, now);
    checkIoDeadline();
    const write = await pool.connect();
    try {
      await write.query('BEGIN');
      const lockedSite = (
        await write.query<{ id: string; timezone: string | null; rate_country: string | null }>(
          'SELECT id, timezone, rate_country FROM "Site" WHERE id = $1 FOR UPDATE',
          [siteId]
        )
      ).rows[0];
      const current = await write.query<{ claim: string; choice: string }>('SELECT updated_at::text AS claim, choice FROM "SiteUtility" WHERE site_id = $1 FOR UPDATE', [siteId]);
      if (current.rows[0]?.claim !== claim) { await write.query('ROLLBACK'); return { status: 'pending', changedDays: 0 }; }
      checkIoDeadline();
      const writeEligibility = deriveRatePlanEligibility(lockedSite?.rate_country ?? null);
      const effectivePreview: Preview =
        writeEligibility === 'us'
          ? preview
          : {
              utilityName: null,
              status: 'ready',
              ownerPicked: false,
              fallbackTariffIds: [],
              planBackfill: null,
              anchors: [],
              actual: [],
              reference: [],
              changed: [],
              matchOutcomes: [],
            };
      const old = await write.query<{ tariff_id: number; role: string; urdb_label: string | null; content_hash: string | null; start_date: string }>(`SELECT u.tariff_id, u.role, u.urdb_label, t.content_hash, u.start_date::text FROM "TariffUrdbSource" u JOIN "Tariff" t ON t.id = u.tariff_id WHERE u.site_id = $1 AND u.role IN ('tesla_anchor', 'estimated_actual', 'estimated_reference', 'owner_selection')`, [siteId]);
      await clearUnprotectedUrdbSourcesOnClient(write, siteId);
      if (effectivePreview.planBackfill) {
        await write.query('UPDATE "Tariff" SET plan_name = $3, plan_code = $4 WHERE id = $1 AND site_id = $2 AND plan_name IS NULL AND plan_code IS NULL', [effectivePreview.planBackfill.tariffId, siteId, effectivePreview.planBackfill.name, effectivePreview.planBackfill.code]);
      }
      for (const anchor of effectivePreview.anchors) {
        await write.query(`INSERT INTO "TariffUrdbSource" (tariff_id, site_id, role, urdb_label, start_date, start_source, newer_urdb_label, newer_urdb_name, newer_urdb_start, is_current_estimate) VALUES ($1, $2, 'tesla_anchor', $3, $4::date, $5, $6, $7, $8::date, TRUE) ON CONFLICT (tariff_id) DO UPDATE SET role = EXCLUDED.role, urdb_label = EXCLUDED.urdb_label, start_date = EXCLUDED.start_date, start_source = EXCLUDED.start_source, newer_urdb_label = EXCLUDED.newer_urdb_label, newer_urdb_name = EXCLUDED.newer_urdb_name, newer_urdb_start = EXCLUDED.newer_urdb_start, is_current_estimate = TRUE`, [anchor.tariffId, siteId, anchor.label, anchor.startDate, anchor.startSource, anchor.newer?.label ?? null, anchor.newer?.name ?? null, anchor.newer ? urdbStartDate(anchor.newer) : null]);
      }
      const estimates = [...effectivePreview.actual, ...effectivePreview.reference];
      const reusedTariffIds = new Set<number>();
      for (const item of estimates) {
        const parsed = compileSeasonsToParsedTariff(item.name, item.seasons);
        const hash = tariffContentHash(parsed);
        const matching = old.rows.filter(row => row.role === item.role && row.urdb_label === item.span.rate.label
          && row.content_hash === hash && !reusedTariffIds.has(Number(row.tariff_id)));
        // A tariff ID can store only one source span. Reserve matching starts for their own spans
        // so a default revision can keep its identity even when it also reappears as a followed plan.
        const previous = matching.find(row => row.start_date === item.span.effectiveFrom)
          ?? matching.find(row => !estimates.some(estimate => estimate.role === row.role
            && estimate.span.rate.label === row.urdb_label && estimate.span.effectiveFrom === row.start_date));
        const tariffId = previous ? Number(previous.tariff_id) : await insertTariffGraph(write, siteId, parsed, 'estimated', null, false, hash);
        reusedTariffIds.add(tariffId);
        await write.query(`INSERT INTO "TariffUrdbSource" (tariff_id, site_id, role, urdb_label, start_date, end_date, start_source, revision_start, is_current_estimate) VALUES ($1, $2, $3, $4, $5::date, $6::date, 'urdb', $7::date, TRUE) ON CONFLICT (tariff_id) DO UPDATE SET role = EXCLUDED.role, urdb_label = EXCLUDED.urdb_label, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date, start_source = EXCLUDED.start_source, revision_start = EXCLUDED.revision_start, is_current_estimate = TRUE`, [tariffId, siteId, item.role, item.span.rate.label, item.span.effectiveFrom, item.span.effectiveTo, urdbStartDate(item.span.rate)]);
      }
      const today = siteLocalDateString(now, lockedSite?.timezone ?? 'UTC');
      const skipCoverageCheck = current.rows[0].choice === 'skipped' || writeEligibility !== 'us';
      const beforeCoverage = skipCoverageCheck ? [] : (await write.query<{ source: string; effective_from: string; effective_to: string | null; kind: string }>(`SELECT source, effective_from::text, effective_to::text, 'actual' AS kind FROM "TariffEffectivePeriod" WHERE site_id = $1 UNION ALL SELECT source, effective_from::text, effective_to::text, 'reference' AS kind FROM "TariffReferencePeriod" WHERE site_id = $1`, [siteId])).rows;
      if (effectivePreview.ownerPicked && effectivePreview.fallbackTariffIds.length) {
        // The importer creates a synthetic Tesla fallback when Tesla has no plan. Once an
        // owner picks a public plan, only overlapping, unedited fallback days are replaced.
        const currentSpans = await loadExistingSpans(write, siteId);
        for (const fallback of currentSpans.filter(row => row.source === 'tesla' && !isProtectedSpan(row) && effectivePreview.fallbackTariffIds.includes(row.tariffId))) {
          let parts = [{ from: fallback.effectiveFrom, to: fallback.effectiveTo }];
          for (const estimate of effectivePreview.actual) {
            const start = estimate.span.effectiveFrom;
            const finish = estimate.span.effectiveTo;
            parts = parts.flatMap(part => {
              if ((part.to !== null && part.to < start) || (finish !== null && finish < part.from)) return [part];
              const remaining: typeof parts = [];
              if (part.from < start) remaining.push({ from: part.from, to: addCalendarDays(start, -1) });
              if (finish !== null && (part.to === null || part.to > finish)) remaining.push({ from: addCalendarDays(finish, 1), to: part.to });
              return remaining;
            });
          }
          if (parts.length === 1 && parts[0].from === fallback.effectiveFrom && parts[0].to === fallback.effectiveTo) continue;
          await write.query('DELETE FROM "TariffEffectivePeriod" WHERE site_id = $1 AND id = $2', [siteId, fallback.id]);
          for (const part of parts) await write.query(`INSERT INTO "TariffEffectivePeriod" (site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id, selection_id) VALUES ($1, $2, $3::date, $4::date, 'tesla', NULL, $5)`, [siteId, fallback.tariffId, part.from, part.to, fallback.selectionId ?? null]);
        }
      }

      const { changed } = await applyEstimatesOnClient(write, siteId, today);
      if (beforeCoverage.length) {
        const afterCoverage = (await write.query<{ effective_from: string; effective_to: string | null; kind: string }>(`SELECT effective_from::text, effective_to::text, 'actual' AS kind FROM "TariffEffectivePeriod" WHERE site_id = $1 UNION ALL SELECT effective_from::text, effective_to::text, 'reference' AS kind FROM "TariffReferencePeriod" WHERE site_id = $1`, [siteId])).rows;
        // An owner-followed plan that cannot be fetched intentionally leaves [from, ∞) uncovered: estimated
        // reference days there may go. Owner rows, actual days and reference days before `from` stay guarded.
        const follow = (await write.query<{ label: string | null; from: string | null }>('SELECT urdb_reference_label AS label, urdb_reference_from::text AS from FROM "SiteUtility" WHERE site_id = $1', [siteId])).rows[0];
        const followedFrom = follow?.label ? follow.from : null;
        const guarded = beforeCoverage.flatMap(before => {
          if (!followedFrom || before.kind !== 'reference' || before.source !== 'estimated') return [before];
          if (before.effective_from >= followedFrom) return [];
          const last = addCalendarDays(followedFrom, -1);
          return [before.effective_to === null || before.effective_to > last ? { ...before, effective_to: last } : before];
        });
        for (const before of guarded) {
          let cursor = before.effective_from;
          const following = afterCoverage.filter(row => row.kind === before.kind).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
          let covered = false;
          for (const row of following) {
            if (row.effective_to !== null && row.effective_to < cursor) continue;
            if (row.effective_from > cursor) break;
            if (row.effective_to === null || (before.effective_to !== null && row.effective_to >= before.effective_to)) { covered = true; break; }
            cursor = addCalendarDays(row.effective_to, 1);
          }
          if (!covered) throw new Error('URDB refresh would remove previously covered days');
        }
      }
      if (changed.length) {
        const fromDate = changed.reduce((min, range) => range.from < min ? range.from : min, changed[0].from);
        const toDate = changed.some(range => range.to === null) ? null : changed.reduce<string>((max, range) => range.to && range.to > max ? range.to : max, '');
        await enqueueReattributionOnClient(write, { siteId, fromDate, toDate, requestedByUserId: null, trigger: 'estimate' });
      }
      const nextCheckExpr = writeEligibility === 'us' ? "$4::timestamptz + interval '7 days'" : 'NULL';
      await write.query(`UPDATE "SiteUtility" SET urdb_utility = CASE WHEN choice = 'auto' THEN $2 ELSE urdb_utility END, status = $3, attempt_count = 0, last_error = NULL, checked_at = $4, next_check_at = ${nextCheckExpr}, updated_at = clock_timestamp() WHERE site_id = $1`, [siteId, effectivePreview.utilityName, effectivePreview.status, now]);
      await bumpSiteTimelineRevisionOnClient(write, siteId);
      checkIoDeadline();
      await write.query('COMMIT');
      new SiteRepo().invalidateCache(siteId);
      logEvent('info', 'urdb.site.completed', { siteId, actualCount: effectivePreview.actual.length, referenceCount: effectivePreview.reference.length, matchOutcomes: effectivePreview.matchOutcomes });
      const changedDays = changed.reduce((sum, range) => sum + Math.max(0, Math.floor((Date.parse(`${range.to ?? today}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86400000) + 1), 0);
      return { status: effectivePreview.status, changedDays };
    } catch (error) { await write.query('ROLLBACK'); throw error; } finally { write.release(); }
  } catch (error) {
    await pool.query(`UPDATE "SiteUtility" SET status = 'failed', attempt_count = attempt_count + 1, last_error = $3, next_check_at = $4::timestamptz + LEAST(interval '7 days', interval '1 hour' * power(2, LEAST(attempt_count + 1, 8))), updated_at = clock_timestamp() WHERE site_id = $1 AND updated_at::text = $2 AND status = 'running'`, [siteId, claim, error instanceof Error ? error.message.slice(0, 500) : 'Unknown error', now]);
    throw error;
  }
}
export async function runUrdbEstimatesCron(opts: { maxTimeMs: number; maxSites: number; api?: UrdbApi }): Promise<{ checked: number; sites: Array<{ siteId: string; status: SiteUtilityStatus }>; stopped?: 'time' | 'disabled' }> {
  if (!process.env.OPENEI_API_KEY && !opts.api) { logEvent('info', 'urdb.disabled', {}); return { checked: 0, sites: [], stopped: 'disabled' }; }
  const start = Date.now();
  const due = await pool.query<{ id: string }>(
    `SELECT s.id
     FROM "Site" s
     LEFT JOIN "SiteUtility" u ON u.site_id = s.id
     WHERE s.orphaned_at IS NULL
       AND (
         (
           s.rate_country = ANY($2::text[])
           AND (
             u.site_id IS NULL
             OR u.status = 'pending'
             OR (u.status = 'running' AND u.updated_at < now() - interval '5 minutes')
             OR (u.status IN ('ready', 'needs_utility', 'needs_plan', 'failed') AND u.next_check_at <= now())
           )
         )
         OR (
           (s.rate_country IS NULL OR NOT (s.rate_country = ANY($2::text[])))
           AND (
             u.status IN ('pending', 'needs_utility', 'needs_plan', 'failed')
             OR (u.status = 'running' AND u.updated_at < now() - interval '5 minutes')
             OR (u.status = 'ready' AND u.next_check_at IS NOT NULL AND u.next_check_at <= now())
             OR EXISTS (
               SELECT 1
               FROM "TariffEffectivePeriod" p
               LEFT JOIN "TariffSelection" ts ON ts.id = p.selection_id
               WHERE p.site_id = s.id
                 AND p.source = 'estimated'
                 AND p.updated_by_user_id IS NULL
                 AND COALESCE(ts.choice_kind, 'automatic') <> 'owner'
             )
             OR EXISTS (
               SELECT 1
               FROM "TariffReferencePeriod" r
               LEFT JOIN "TariffSelection" ts ON ts.id = r.selection_id
               WHERE r.site_id = s.id
                 AND r.source = 'estimated'
                 AND r.updated_by_user_id IS NULL
                 AND COALESCE(ts.choice_kind, 'automatic') <> 'owner'
             )
           )
         )
       )
     -- An owner may be waiting on a new or pending site (a utility, plan or country just changed);
     -- run those before routine rechecks and cleanup, which can be a long backlog.
     ORDER BY (u.site_id IS NULL OR u.status = 'pending') DESC, u.updated_at NULLS FIRST
     LIMIT $1`,
    [opts.maxSites, [...US_ELIGIBLE_COUNTRY_LIST]]
  );
  const sites: Array<{ siteId: string; status: SiteUtilityStatus }> = [];
  for (const row of due.rows) {
    if (Date.now() - start >= opts.maxTimeMs) return { checked: sites.length, sites, stopped: 'time' };
    checkIoDeadline();
    try { const remaining = opts.maxTimeMs - (Date.now() - start); const result = await withIoDeadline(remaining, () => runUrdbEstimatesForSite(row.id, opts.api ?? client, new Date())); sites.push({ siteId: row.id, status: result.status }); }
    catch { sites.push({ siteId: row.id, status: 'failed' }); }
  }
  return { checked: sites.length, sites };
}
