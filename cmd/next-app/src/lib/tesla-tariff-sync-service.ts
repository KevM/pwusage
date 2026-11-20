import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { pool as defaultPool } from './db';
import { Importer } from './importer';
import type { SiteTariffsTimelineResponse, TariffSeasonInput } from './tariff-contract';
import type { TariffSource } from './db-types';
import { canonicalizeValue } from './tariff-selection';
import { siteLocalDateString } from './tariff-timeline';
import {
  type ActiveActualPlan,
  TariffNotFoundError,
  TariffTimelineRepo,
  type SiteUtilityContextResult,
} from './tariff-timeline-repo';
import { TeslaTariffSyncRepo, type TeslaSyncFinalStatus } from './tesla-tariff-sync-repo';
import { isTeslaConnectionRequired } from './tesla-refresh-outcome';
import { createTeslaClientForSiteMember } from './tesla-client-factory';
import { isTeslaAuthError, TeslaAuthError, type EnergySiteInfo, type TariffV2, type TeslaClient } from './tesla-client';
import {
  applyTeslaAdjustments,
  buildTeslaTariff,
  seasonsFromTeslaContent,
  teslaPlansMatch,
  validateForTesla,
  type TeslaRateAdjustment,
  type TeslaSyncProblem,
} from './tesla-tou-sync';

/** Read-back: five reads, four seconds apart, so the whole write and check stays inside 20 s. */
const READ_BACK_ATTEMPTS = 5;
const READ_BACK_INTERVAL_MS = 4000;

export type TeslaSyncUnavailableReason =
  | 'no_active_plan'
  | 'no_difference'
  | 'not_tou_capable'
  | 'no_tesla_plan'
  | 'needs_reauth';

const UNAVAILABLE_COPY: Record<TeslaSyncUnavailableReason, string> = {
  no_active_plan: 'No rate plan covers today, so there is nothing to send.',
  no_difference: 'Tesla already has this plan.',
  not_tou_capable: "This Powerwall can't use time-of-use rates, so there is nothing to sync.",
  no_tesla_plan: 'Tesla has no rate plan to update yet.',
  needs_reauth: 'Reconnect Tesla to sync this plan.',
};

const CONFIRMED_COPY = 'Tesla now has this plan.';
const UNCONFIRMED_COPY = "Sent to Tesla. It hasn't confirmed yet; PWUsage will check again.";
const CONFLICT_COPY = 'Tesla or your rate plan changed since you reviewed it. Review the plan again before syncing.';
const IN_FLIGHT_COPY = 'A sync to Tesla is already in progress for this site.';
const NOT_ALLOWED_COPY = "Tesla didn't let your account change this Powerwall.";
const REJECTED_FALLBACK_COPY = 'Tesla did not accept this plan.';
const FAILED_COPY = "Sync to Tesla didn't finish. Try again in a moment.";

/** Raised when a plan cannot be sent right now. Preview throws it; commit turns it into an outcome. */
export class TeslaSyncUnavailableError extends Error {
  constructor(readonly reason: TeslaSyncUnavailableReason) {
    super(UNAVAILABLE_COPY[reason]);
    this.name = 'TeslaSyncUnavailableError';
  }
}

export interface TeslaSyncPreview {
  fingerprint: string;
  /** Tesla's plan as it stands now, read fresh. */
  current: { name: string; seasons: TariffSeasonInput[] };
  /** PWUsage's plan for today, the one Sync to Tesla would send. */
  proposed: { name: string; seasons: TariffSeasonInput[]; source: TariffSource; selectionId: number | null };
  adjustments: TeslaRateAdjustment[];
  problems: TeslaSyncProblem[];
  estimated: boolean;
}

export type TeslaSyncOutcome =
  | 'confirmed'
  | 'unconfirmed'
  | 'rejected'
  | 'failed'
  | 'not_allowed'
  | 'needs_reauth'
  | 'conflict'
  | 'in_flight'
  | 'unavailable';

export interface TeslaSyncResult {
  outcome: TeslaSyncOutcome;
  message?: string;
  timeline?: SiteTariffsTimelineResponse;
}

/** The connection that holds the Site row lock. */
type SyncConnection = Pick<PoolClient, 'query' | 'release'>;

export interface TeslaTariffSyncDeps {
  clientFor?: (siteId: string, userId: string) => Promise<TeslaClient | null>;
  repo?: Pick<TariffTimelineRepo, 'getSiteUtilityContext' | 'getTimeline' | 'loadActiveActualPlan'>;
  syncRepo?: Pick<TeslaTariffSyncRepo, 'beginAttempt' | 'finishAttempt'>;
  connect?: () => Promise<SyncConnection>;
  importSite?: (client: TeslaClient, siteId: string) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface ResolvedDeps {
  clientFor: (siteId: string, userId: string) => Promise<TeslaClient | null>;
  repo: Pick<TariffTimelineRepo, 'getSiteUtilityContext' | 'getTimeline' | 'loadActiveActualPlan'>;
  syncRepo: Pick<TeslaTariffSyncRepo, 'beginAttempt' | 'finishAttempt'>;
  connect: () => Promise<SyncConnection>;
  importSite: (client: TeslaClient, siteId: string) => Promise<void>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

function resolveDeps(deps: TeslaTariffSyncDeps = {}): ResolvedDeps {
  return {
    clientFor: deps.clientFor ?? createTeslaClientForSiteMember,
    repo: deps.repo ?? new TariffTimelineRepo(),
    syncRepo: deps.syncRepo ?? new TeslaTariffSyncRepo(),
    connect: deps.connect ?? (() => defaultPool.connect()),
    importSite: deps.importSite ?? (async (client, siteId) => {
      await new Importer(client).ensureSite(siteId);
    }),
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))),
  };
}

/**
 * Digest over everything the write depends on: the active selection, PWUsage's seasons, Tesla's
 * content as read and the payload that would be written. A commit whose fingerprint differs from
 * the preview's is a conflict.
 */
function syncFingerprint(siteId: string, plan: ActiveActualPlan, content: TariffV2): { fingerprint: string; payload: TariffV2 } {
  const payload = buildTeslaTariff(content, { name: plan.name, seasons: plan.seasons });
  const canonical = canonicalizeValue({
    version: 1,
    siteId,
    selectionId: plan.selectionId,
    proposedSeasons: plan.seasons,
    freshTeslaContent: content,
    payload,
  });
  return { fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'), payload };
}

interface PreparedSync {
  site: SiteUtilityContextResult;
  plan: ActiveActualPlan;
  content: TariffV2;
  currentSeasons: TariffSeasonInput[];
  payload: TariffV2;
  fingerprint: string;
  currency: string;
}

/** Reads the site's active plan and Tesla's current content (no lock, no write). */
async function prepare(siteId: string, client: TeslaClient, d: ResolvedDeps): Promise<PreparedSync> {
  const site = await d.repo.getSiteUtilityContext(siteId);
  if (!site) throw new TariffNotFoundError('Site not found');
  const today = siteLocalDateString(d.now(), site.timezone || 'UTC');
  const plan = await d.repo.loadActiveActualPlan(siteId, today);
  if (!plan) throw new TeslaSyncUnavailableError('no_active_plan');

  const info = await client.getEnergySiteInfo(siteId);
  if (!info.components?.tou_capable) throw new TeslaSyncUnavailableError('not_tou_capable');
  if (!info.tariff_content_v2) throw new TeslaSyncUnavailableError('no_tesla_plan');

  const content = info.tariff_content_v2;
  const { fingerprint, payload } = syncFingerprint(siteId, plan, content);
  return {
    site,
    plan,
    content,
    currentSeasons: seasonsFromTeslaContent(content),
    payload,
    fingerprint,
    currency: (site.currency || 'USD').trim().toUpperCase(),
  };
}

/** What the owner sees before pressing Sync to Tesla. Read-only. */
export async function previewTeslaSync(
  siteId: string,
  userId: string,
  deps?: TeslaTariffSyncDeps
): Promise<TeslaSyncPreview> {
  const d = resolveDeps(deps);
  const client = await d.clientFor(siteId, userId);
  if (!client) throw new TeslaSyncUnavailableError('needs_reauth');

  const prep = await prepare(siteId, client, d);
  if (teslaPlansMatch(prep.plan.seasons, prep.currentSeasons, {
    pwusageCurrency: prep.currency,
    teslaCurrency: prep.content.currency,
  })) {
    throw new TeslaSyncUnavailableError('no_difference');
  }

  return {
    fingerprint: prep.fingerprint,
    current: { name: prep.content.name, seasons: prep.currentSeasons },
    proposed: {
      name: prep.plan.name,
      seasons: prep.plan.seasons,
      source: prep.plan.source,
      selectionId: prep.plan.selectionId,
    },
    adjustments: applyTeslaAdjustments(prep.plan.seasons).adjustments,
    problems: validateForTesla(prep.plan.seasons, prep.currency),
    estimated: prep.plan.source === 'estimated',
  };
}

type TeslaFailureOutcome = 'not_allowed' | 'needs_reauth' | 'rejected' | 'failed';

const TESLA_API_ERROR = /^Tesla API Error: (\d{3}) ([\s\S]*)$/;

/** The text of Tesla's error body as plain words. Raw JSON and truncated bodies are never shown. */
function plainTeslaText(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return REJECTED_FALLBACK_COPY;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return messageFromBody(parsed) ?? REJECTED_FALLBACK_COPY;
    } catch {
      return REJECTED_FALLBACK_COPY;
    }
  }
  return trimmed.endsWith('...') ? REJECTED_FALLBACK_COPY : trimmed;
}

function messageFromBody(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  for (const key of ['error_description', 'error', 'message']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** Tesla's 4xx answer, other than auth, as a message. The TeslaClient error carries the status and body. */
function teslaRejectionMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = TESLA_API_ERROR.exec(error.message);
  if (!match) return null;
  const status = Number(match[1]);
  if (status < 400 || status >= 500 || status === 401 || status === 403 || status === 429) return null;
  return plainTeslaText(match[2]);
}

function classifyTeslaError(error: unknown): { outcome: TeslaFailureOutcome; message: string } {
  if (error instanceof TeslaAuthError && error.status === 403) {
    return { outcome: 'not_allowed', message: NOT_ALLOWED_COPY };
  }
  if (isTeslaAuthError(error) || isTeslaConnectionRequired(error)) {
    return { outcome: 'needs_reauth', message: UNAVAILABLE_COPY.needs_reauth };
  }
  const rejection = teslaRejectionMessage(error);
  if (rejection !== null) return { outcome: 'rejected', message: rejection };
  return { outcome: 'failed', message: FAILED_COPY };
}

/** The stored attempt status for a failure. A lost Tesla session is recorded as failed. */
function storedStatus(outcome: TeslaFailureOutcome): TeslaSyncFinalStatus {
  return outcome === 'needs_reauth' ? 'failed' : outcome;
}

type LockOutcome = { attemptId: number } | { stop: TeslaSyncResult };

/**
 * Under the Site row lock: re-reads today's plan, confirms the fingerprint still matches, and
 * records the attempt. No network call happens here; the transaction commits before the write.
 */
async function beginAttemptUnderLock(
  siteId: string,
  userId: string,
  prep: PreparedSync,
  d: ResolvedDeps
): Promise<LockOutcome> {
  const tx = await d.connect();
  try {
    await tx.query('BEGIN');
    const site = await tx.query<{ timezone: string }>('SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);
    const timezone = site.rows[0]?.timezone;
    if (!timezone) throw new TariffNotFoundError('Site not found');

    const locked = await d.repo.loadActiveActualPlan(siteId, siteLocalDateString(d.now(), timezone), tx);
    const lockedFingerprint = locked ? syncFingerprint(siteId, locked, prep.content).fingerprint : null;
    if (!locked || lockedFingerprint !== prep.fingerprint) {
      await tx.query('ROLLBACK');
      return { stop: { outcome: 'conflict', message: CONFLICT_COPY } };
    }

    const latestTesla = await tx.query<{ id: number }>(
      `SELECT id FROM "Tariff" WHERE site_id = $1 AND source = 'tesla' ORDER BY id DESC LIMIT 1`,
      [siteId]
    );
    const begun = await d.syncRepo.beginAttempt(tx, {
      siteId,
      userId,
      fingerprint: prep.fingerprint,
      selectionId: locked.selectionId,
      replacedTeslaTariffId: latestTesla.rows[0] ? Number(latestTesla.rows[0].id) : null,
      sentContent: prep.payload,
    });
    await tx.query('COMMIT');
    if ('inFlight' in begun) return { stop: { outcome: 'in_flight', message: IN_FLIGHT_COPY } };
    return { attemptId: begun.id };
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

/** Reads Tesla up to five times after the write. A failed read counts as not matching. */
async function readBackMatches(client: TeslaClient, siteId: string, prep: PreparedSync, d: ResolvedDeps): Promise<boolean> {
  for (let read = 0; read < READ_BACK_ATTEMPTS; read++) {
    await d.sleep(READ_BACK_INTERVAL_MS);
    try {
      const info: EnergySiteInfo = await client.getEnergySiteInfo(siteId);
      const content = info.tariff_content_v2;
      if (content && teslaPlansMatch(prep.plan.seasons, seasonsFromTeslaContent(content), {
        pwusageCurrency: prep.currency,
        teslaCurrency: content.currency,
      })) {
        return true;
      }
    } catch {
      // Not matching yet: the next read may succeed.
    }
  }
  return false;
}

/**
 * Sends today's plan to Tesla. Only this function writes. A stale fingerprint, a second press
 * while an attempt is sending, and a plan with problems all stop before any write.
 */
export async function commitTeslaSync(
  siteId: string,
  userId: string,
  fingerprint: string,
  deps?: TeslaTariffSyncDeps
): Promise<TeslaSyncResult> {
  const d = resolveDeps(deps);
  const client = await d.clientFor(siteId, userId);
  if (!client) return { outcome: 'needs_reauth', message: UNAVAILABLE_COPY.needs_reauth };

  let prep: PreparedSync;
  try {
    prep = await prepare(siteId, client, d);
  } catch (error) {
    if (error instanceof TariffNotFoundError) throw error;
    if (error instanceof TeslaSyncUnavailableError) {
      return { outcome: error.reason === 'needs_reauth' ? 'needs_reauth' : 'unavailable', message: error.message };
    }
    const failure = classifyTeslaError(error);
    return { outcome: failure.outcome, message: failure.message };
  }

  if (prep.fingerprint !== fingerprint) return { outcome: 'conflict', message: CONFLICT_COPY };

  const problems = validateForTesla(prep.plan.seasons, prep.currency);
  if (problems.length > 0) {
    return { outcome: 'unavailable', message: problems.map(problem => problem.message).join(' ') };
  }

  const locked = await beginAttemptUnderLock(siteId, userId, prep, d);
  if ('stop' in locked) return locked.stop;
  const { attemptId } = locked;

  let written: Awaited<ReturnType<TeslaClient['setTimeOfUseSettings']>>;
  try {
    written = await client.setTimeOfUseSettings(siteId, prep.payload);
  } catch (error) {
    const failure = classifyTeslaError(error);
    await d.syncRepo.finishAttempt(attemptId, storedStatus(failure.outcome), { error: failure.message });
    return { outcome: failure.outcome, message: failure.message };
  }

  const matches = await readBackMatches(client, siteId, prep, d);
  if (matches) {
    await d.syncRepo.finishAttempt(attemptId, 'confirmed', written);
    try {
      await d.importSite(client, siteId);
    } catch (error) {
      console.warn(`[TeslaSync] Import after confirming site ${siteId} failed`, error);
    }
    return { outcome: 'confirmed', message: CONFIRMED_COPY, timeline: await d.repo.getTimeline(siteId, userId) };
  }

  await d.syncRepo.finishAttempt(attemptId, 'unconfirmed', written);
  return { outcome: 'unconfirmed', message: UNCONFIRMED_COPY, timeline: await d.repo.getTimeline(siteId, userId) };
}
