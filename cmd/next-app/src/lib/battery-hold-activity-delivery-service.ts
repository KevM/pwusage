import { randomUUID } from 'node:crypto';
import {
  activityErrorTag, allowedApnsEnvironments, BatteryHoldActivityRepo, reconcileBatteryHoldActivities,
  type ApnsEnvironment, type ClaimedActivity,
} from './battery-hold-activity-repo';
import {
  APNS_REQUEST_TIMEOUT_MS, ApnsClient, apnsCredentialsFromEnv, buildLiveActivityRequest,
  type ApnsCredentials, type ApnsResult, type ApnsSendRequest,
} from './battery-hold-apns';
import { withIoDeadline } from './io-deadline';

// Separate from the 60 s battery monitor. Worst case: 2 s reconcile + 2 s claim
// + 15 s of sends (the last starts no later than one request timeout before the
// end) + bookkeeping writes + session close, comfortably inside the route's 30 s.
export const DELIVERY_BATCH_LIMIT = 50;
export const DELIVERY_CONCURRENCY = 8;
export const DELIVERY_SEND_BUDGET_MS = 15_000;
const DB_BUDGET_MS = 2000;
const MINUTE = 60_000;
const MAX_RETRY_DELAY_MS = 30 * MINUTE;
// Apple: retry 5xx responses after 15 minutes.
const APPLE_SERVER_ERROR = /^(?:InternalServerError|ServiceUnavailable|Shutdown|http_5\d\d)$/;

type DeliveryClient = Pick<ApnsClient, 'send' | 'close'>;

export interface DeliveryDeps {
  credentials?: ApnsCredentials | null;
  environments?: ApnsEnvironment[];
  repo?: BatteryHoldActivityRepo;
  createClient?: (credentials: ApnsCredentials) => DeliveryClient;
  batchLimit?: number;
  concurrency?: number;
  sendBudgetMs?: number;
  requestTimeoutMs?: number;
}

export interface DeliverySummary {
  status: 'unconfigured' | 'idle' | 'ran';
  claimed: number; accepted: number; deferred: number; disabled: number; rejected: number; released: number;
  credentialFailure: string | null;
  runtimeMs: number;
}

/** Exponential retry delay for the `attempt`th failure (1-based). */
export function retryDelayMs(attempt: number, result: Exclude<ApnsResult, { kind: 'accepted' | 'invalid_token' }>): number {
  if (result.kind === 'rejected') return MAX_RETRY_DELAY_MS;
  const base = result.kind === 'credentials' ? 5 * MINUTE : MINUTE;
  const floor = result.kind === 'transient' && APPLE_SERVER_ERROR.test(result.reason) ? 15 * MINUTE : 0;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(floor, base * 2 ** Math.min(Math.max(attempt - 1, 0), 10)));
}

/**
 * One delivery run: reconcile desired state, claim a bounded batch and send each
 * claimed version to APNs with bounded parallelism, awaiting every attempt.
 * Without credentials it does nothing at all; with nothing pending it never
 * contacts Apple. A run that dies leaves its rows pending: their claims lapse
 * after DELIVERY_CLAIM_LEASE_SECONDS and the next run takes them.
 */
export async function deliverBatteryHoldActivities(deps: DeliveryDeps = {}): Promise<DeliverySummary> {
  const started = Date.now();
  const summary: DeliverySummary = {
    status: 'unconfigured', claimed: 0, accepted: 0, deferred: 0, disabled: 0, rejected: 0, released: 0,
    credentialFailure: null, runtimeMs: 0,
  };
  const credentials = deps.credentials === undefined ? apnsCredentialsFromEnv() : deps.credentials;
  if (!credentials) return finish(summary, started);

  const repo = deps.repo ?? new BatteryHoldActivityRepo();
  const owner = randomUUID();
  await reconcileBatteryHoldActivities();
  const claims = await withIoDeadline(DB_BUDGET_MS, () => repo.claimForDelivery({
    owner, environments: deps.environments ?? allowedApnsEnvironments(), limit: deps.batchLimit ?? DELIVERY_BATCH_LIMIT,
  }), null);
  summary.status = claims.length ? 'ran' : 'idle';
  summary.claimed = claims.length;
  if (!claims.length) return finish(summary, started);

  const requestTimeoutMs = deps.requestTimeoutMs ?? APNS_REQUEST_TIMEOUT_MS;
  const sendDeadline = started + (deps.sendBudgetMs ?? DELIVERY_SEND_BUDGET_MS);
  const client = (deps.createClient ?? (c => new ApnsClient({ credentials: c, requestTimeoutMs })))(credentials);
  const blocked = new Set<ApnsEnvironment>();
  const write = async (what: string, work: () => Promise<unknown>) => {
    try { await withIoDeadline(DB_BUDGET_MS, work, null); }
    catch (e) { console.warn(`[ActivityDelivery] ${what} write deferred to lease expiry`, activityErrorTag(e)); }
  };
  const defer = (activity: ClaimedActivity, result: Exclude<ApnsResult, { kind: 'accepted' | 'invalid_token' }>) =>
    write('backoff', () => repo.deferDelivery(activity.id, owner, activity.version, {
      error: result.reason, retryAt: new Date(Date.now() + retryDelayMs(activity.attempts + 1, result)),
    }));

  const deliver = async (activity: ClaimedActivity) => {
    if (blocked.has(activity.apnsEnvironment) || Date.now() + requestTimeoutMs > sendDeadline) {
      summary.released++;
      await write('release', () => repo.releaseClaim(activity.id, owner));
      return;
    }
    let request: ApnsSendRequest;
    try {
      request = { environment: activity.apnsEnvironment, token: activity.pushToken, ...buildLiveActivityRequest(activity.snapshot, activity.expiresAt) };
    } catch {
      summary.rejected++;
      console.error(`[ActivityDelivery] Activity ${activity.id} snapshot cannot be sent`);
      await defer(activity, { kind: 'rejected', reason: 'InvalidSnapshot' });
      return;
    }
    let result: ApnsResult;
    try { result = await client.send(request); }
    catch (e) { result = { kind: 'transient', reason: activityErrorTag(e) }; }
    switch (result.kind) {
      case 'accepted':
        summary.accepted++;
        await write('completion', () => repo.completeDelivery(activity.id, owner, activity.version));
        return;
      case 'invalid_token':
        summary.disabled++;
        await write('disable', () => repo.disableInvalidToken(activity.id, owner, activity.pushToken, result.reason));
        return;
      case 'credentials':
        blocked.add(activity.apnsEnvironment);
        summary.credentialFailure ??= result.reason;
        summary.deferred++;
        await defer(activity, result);
        return;
      case 'rejected':
        summary.rejected++;
        console.error(`[ActivityDelivery] APNs rejected activity ${activity.id}`, result.reason);
        await defer(activity, result);
        return;
      default:
        summary.deferred++;
        await defer(activity, result);
    }
  };

  try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? DELIVERY_CONCURRENCY, claims.length) }, async () => {
      while (next < claims.length) await deliver(claims[next++]);
    }));
  } finally {
    await client.close();
  }
  if (summary.credentialFailure) {
    console.error(`[ActivityDelivery] APNs credentials rejected (${[...blocked].join(', ')})`, summary.credentialFailure);
  }
  return finish(summary, started);
}

function finish(summary: DeliverySummary, started: number): DeliverySummary {
  summary.runtimeMs = Date.now() - started;
  return summary;
}
