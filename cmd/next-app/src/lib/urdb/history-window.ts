import type { PoolClient } from 'pg';
import type { TariffStartSource } from '../db-types';
import { addCalendarDays } from '../tariff-timeline';
import { buildDefaultTariff, tariffContentHash } from '../importer/tariff-parser';

export const HISTORY_GUIDE_MIN_DAYS = 365;
export const HISTORY_GUIDE_MIN_UNCONFIRMED = 30;

type Queryable = { query: PoolClient['query'] };

export interface HistoryWindowInput {
  today: string;
  historyStart: string | null;
  earliestTesla: { firstSeen: string; anchorStart: string | null; anchorSource: TariffStartSource | null } | null;
  manualSpans: Array<{ from: string; to: string | null }>;
  /** The owner chose the site's current plan (SiteUtility.urdb_plan_label, set only by an owner). */
  ownerPickedPlan: boolean;
}
export interface HistoryWindow {
  historyStart: string;
  /** Last day of the fill window; null = open through today. */
  fillThrough: string | null;
  unconfirmedDays: number;
  /** Newest first. */
  askYears: number[];
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Days of [from, to] not covered by any manual span. */
function uncoveredDays(from: string, to: string, spans: HistoryWindowInput['manualSpans']): number {
  const start = dayNumber(from);
  const end = dayNumber(to);
  if (end < start) return 0;
  let covered = 0;
  let cursor = start;
  const clipped = spans.map(span => ({ from: dayNumber(span.from), to: span.to === null ? Infinity : dayNumber(span.to) })).sort((a, b) => a.from - b.from);
  for (const span of clipped) {
    const spanStart = Math.max(span.from, cursor);
    const spanEnd = Math.min(span.to, end);
    if (spanEnd < spanStart) continue;
    covered += spanEnd - spanStart + 1;
    cursor = spanEnd + 1;
  }
  return end - start + 1 - covered;
}

/** The first day a non-owner source is known to be right: null without Tesla versions. */
function trustedStart(earliestTesla: HistoryWindowInput['earliestTesla']): string | null {
  return earliestTesla ? (earliestTesla.anchorSource === 'urdb' && earliestTesla.anchorStart ? earliestTesla.anchorStart : earliestTesla.firstSeen) : null;
}

/** The fill window's bounds with no offer thresholds: what a save may write. */
export function fillWindowBounds(input: HistoryWindowInput): { historyStart: string; fillThrough: string | null } | null {
  if (!input.historyStart) return null;
  const trusted = trustedStart(input.earliestTesla);
  return { historyStart: input.historyStart, fillThrough: trusted ? addCalendarDays(trusted, -1) : null };
}

/**
 * Without Tesla versions, the owner's plan pick covers the days from their latest own plan on (the
 * guide saves its open period as the pick): those days count as confirmed.
 */
function confirmedSpans(input: HistoryWindowInput): HistoryWindowInput['manualSpans'] {
  const { historyStart, earliestTesla, manualSpans, ownerPickedPlan } = input;
  if (earliestTesla || !ownerPickedPlan || !historyStart) return manualSpans;
  if (manualSpans.some(span => span.to === null)) return manualSpans;
  const latestEnd = manualSpans.reduce<string | null>((latest, span) => latest === null || (span.to as string) > latest ? span.to : latest, null);
  return [...manualSpans, { from: latestEnd ? addCalendarDays(latestEnd, 1) : historyStart, to: null }];
}

export function historyWindow(input: HistoryWindowInput): HistoryWindow | null {
  const { today, historyStart, earliestTesla } = input;
  const manualSpans = confirmedSpans(input);
  if (!historyStart || dayNumber(today) - dayNumber(historyStart) < HISTORY_GUIDE_MIN_DAYS) return null;
  const trusted = trustedStart(earliestTesla);
  const fillThrough = trusted ? addCalendarDays(trusted, -1) : null;
  const end = fillThrough ?? today;
  if (end < historyStart) return null;
  const unconfirmedDays = uncoveredDays(historyStart, end, manualSpans);
  if (unconfirmedDays < HISTORY_GUIDE_MIN_UNCONFIRMED) return null;
  const firstYear = Number(historyStart.slice(0, 4));
  const askYears: number[] = [];
  for (let year = Number((trusted ?? today).slice(0, 4)) - 1; year >= firstYear; year--) {
    const from = historyStart > `${year}-01-01` ? historyStart : `${year}-01-01`;
    const to = end < `${year}-12-31` ? end : `${year}-12-31`;
    if (uncoveredDays(from, to, manualSpans) > 0) askYears.push(year);
  }
  if (!askYears.length) return null;
  return { historyStart, fillThrough, unconfirmedDays, askYears };
}

/** July 1 of `year`, clamped into the fill window. */
export function askDate(year: number, window: HistoryWindow, today: string): string {
  const end = window.fillThrough ?? today;
  const mid = `${year}-07-01`;
  return mid < window.historyStart ? window.historyStart : mid > end ? end : mid;
}

export async function loadHistoryWindow(client: Queryable, siteId: string, today: string): Promise<HistoryWindow | null> {
  const input = await loadHistoryWindowInput(client, siteId, today);
  return input && historyWindow(input);
}

export async function loadHistoryWindowInput(client: Queryable, siteId: string, today: string): Promise<HistoryWindowInput | null> {
  const fallbackHash = tariffContentHash(buildDefaultTariff('Default Rate'));
  const start = (await client.query(
    `SELECT COALESCE((SELECT min(day_start AT TIME ZONE tz)::date FROM "EnergyDayArchive" WHERE site_id = s.id), (s.installed AT TIME ZONE tz)::date)::text AS history_start
     FROM (SELECT id, installed, COALESCE(timezone, 'UTC') AS tz FROM "Site" WHERE id = $1) s`, [siteId])).rows[0];
  if (!start?.history_start) return null;
  const tesla = (await client.query(
    `SELECT (((t.updated AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date)::text AS first_seen, u.start_date::text AS anchor_start, u.start_source AS anchor_source
     FROM "Tariff" t JOIN "Site" s ON s.id = t.site_id
     LEFT JOIN "TariffUrdbSource" u ON u.tariff_id = t.id AND u.role = 'tesla_anchor'
     WHERE t.site_id = $1 AND t.source = 'tesla' AND t.content_hash IS DISTINCT FROM $2
     ORDER BY t.updated, t.id LIMIT 1`, [siteId, fallbackHash])).rows[0];
  const manual = (await client.query(`SELECT effective_from::text AS "from", effective_to::text AS "to" FROM "TariffEffectivePeriod" WHERE site_id = $1 AND source = 'manual'`, [siteId])).rows;
  // Only setPlanLabelOnClient sets the label, always with the owner's id; choosing a utility clears it.
  const picked = (await client.query(
    `SELECT 1 FROM "SiteUtility" WHERE site_id = $1 AND choice <> 'skipped' AND urdb_plan_label IS NOT NULL AND updated_by_user_id IS NOT NULL`, [siteId])).rowCount;
  return {
    today,
    historyStart: start.history_start,
    earliestTesla: tesla ? { firstSeen: tesla.first_seen, anchorStart: tesla.anchor_start, anchorSource: tesla.anchor_source } : null,
    manualSpans: manual,
    ownerPickedPlan: Boolean(picked),
  };
}

/** The parts of [from, to] not covered by any manual span, oldest first. */
export function uncoveredPieces(from: string, to: string, spans: HistoryWindowInput['manualSpans']): Array<{ from: string; to: string }> {
  const pieces: Array<{ from: string; to: string }> = [];
  let cursor = from;
  for (const span of [...spans].sort((a, b) => a.from.localeCompare(b.from))) {
    if (cursor > to) break;
    if (span.to !== null && span.to < cursor) continue;
    if (span.from > to) break;
    if (span.from > cursor) pieces.push({ from: cursor, to: addCalendarDays(span.from, -1) });
    if (span.to === null) return pieces;
    cursor = addCalendarDays(span.to, 1);
  }
  if (cursor <= to) pieces.push({ from: cursor, to });
  return pieces;
}
