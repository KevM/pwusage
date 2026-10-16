import http2 from 'node:http2';
import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { ApnsEnvironment } from './battery-hold-activity-repo';

// Server-only Apple Push Notification service client for Live Activity updates.
// Signing material comes from environment variables and never reaches a log,
// an error message or the database.

export const APNS_ORIGINS: Readonly<Record<ApnsEnvironment, string>> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};
export const DEFAULT_APNS_BUNDLE_ID = 'fm.rodeo.pwusage';
export const APNS_REQUEST_TIMEOUT_MS = 4000;
// Apple: refresh the provider token no more than every 20 and no less than every 60 minutes.
const PROVIDER_TOKEN_TTL_MS = 30 * 60_000;
// Swift's default JSONDecoder reads Date as seconds since 2001-01-01T00:00:00Z.
const REFERENCE_EPOCH_S = 978307200;
// The stale date gives a late monitor run this long before the Lock Screen marks the activity stale.
const STALE_GRACE_S = 10 * 60;
const CONTENT_SCHEMA = 1;

export interface ApnsCredentials { keyId: string; teamId: string; privateKey: string; bundleId: string }

/** Credentials from APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY (.p8 PEM) and optional APNS_BUNDLE_ID; null unless complete. */
export function apnsCredentialsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ApnsCredentials | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const privateKey = env.APNS_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (!keyId || !teamId || !privateKey) return null;
  if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId)) return null;
  return { keyId, teamId, privateKey: `${privateKey}\n`, bundleId: env.APNS_BUNDLE_ID?.trim() || DEFAULT_APNS_BUNDLE_ID };
}

class SigningKeyError extends Error { constructor() { super('APNs signing key unusable'); this.name = 'SigningKeyError'; } }

let cachedToken: { cacheKey: string; issuedAtMs: number; token: string } | null = null;
const signingKeys = new Map<string, KeyObject>();

export function resetProviderTokenCache(): void { cachedToken = null; signingKeys.clear(); }

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** ES256 provider token, shared by every request in this instance for 30 minutes. */
export function providerToken(credentials: ApnsCredentials, nowMs = Date.now()): string {
  const cacheKey = `${credentials.teamId}:${credentials.keyId}:${credentials.privateKey}`;
  if (cachedToken?.cacheKey === cacheKey && nowMs - cachedToken.issuedAtMs < PROVIDER_TOKEN_TTL_MS) return cachedToken.token;
  let key = signingKeys.get(cacheKey);
  if (!key) {
    try { key = createPrivateKey(credentials.privateKey); } catch { throw new SigningKeyError(); }
    signingKeys.clear();
    signingKeys.set(cacheKey, key);
  }
  const unsigned = `${base64url({ alg: 'ES256', kid: credentials.keyId })}.${base64url({ iss: credentials.teamId, iat: Math.floor(nowMs / 1000) })}`;
  let signature: Buffer;
  try { signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }); } catch { throw new SigningKeyError(); }
  const token = `${unsigned}.${signature.toString('base64url')}`;
  cachedToken = { cacheKey, issuedAtMs: nowMs, token };
  return token;
}

export interface LiveActivityContentState {
  schema: number; holdId: number; status: string; mode: string; phase: string | null;
  originalReserve: number; targetReserve: number; estimatedLoadW: number | null;
  startedAt: number; safetyExpiresAt: number; checkedAt: number | null; nextCheckAt: number | null;
  endedAt: number | null; restoreReason: string | null; cancelledObservedReserve: number | null;
  /** Home load figures from the monitor's last check; the samples are as of `sampledAt`. */
  sampledAt: number | null; baselineLoadW: number | null; homeLoadW: number | null; peakLoadW: number | null;
  /** Live battery charge (0-100, unrounded) from the last check or hold start. */
  batteryPercent: number | null;
}
export interface LiveActivityPayload {
  aps: {
    timestamp: number; event: 'update' | 'end'; 'content-state': LiveActivityContentState;
    'stale-date'?: number; 'dismissal-date'?: number;
  };
}
export interface LiveActivityRequest { payload: LiveActivityPayload; priority: 5 | 10; expiration: number }

const epochMs = (value: unknown, field: string): number => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`snapshot ${field} is not a timestamp`);
  return ms;
};
const optionalMs = (value: unknown, field: string) => (value === null || value === undefined ? null : epochMs(value, field));
const unixSeconds = (ms: number) => Math.floor(ms / 1000);
const swiftDate = (ms: number | null) => (ms === null ? null : unixSeconds(ms) - REFERENCE_EPOCH_S);
const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null);

/**
 * Maps a desired snapshot (the SQL projection in battery-hold-activity-repo) to
 * an ActivityKit push. Field names and plain-number dates match Swift's default
 * Codable decoding, which ActivityKit always uses. The APNs timestamp is the
 * snapshot's data time rather than the send time, so a delayed older version
 * can never replace a newer one on the device.
 */
export function buildLiveActivityRequest(snapshot: unknown, expiresAt: Date): LiveActivityRequest {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot missing');
  const s = snapshot as Record<string, unknown>;
  const monitoring = (s.monitoring && typeof s.monitoring === 'object' ? s.monitoring : {}) as Record<string, unknown>;
  const startedMs = epochMs(s.created_at, 'created_at');
  const checkedMs = optionalMs(monitoring.checked_at, 'checked_at');
  const nextCheckMs = optionalMs(monitoring.next_check_at, 'next_check_at');
  const endedMs = optionalMs(s.restored_at, 'restored_at');
  const holdId = Number(s.hold_id);
  const originalReserve = numberOrNull(s.original_reserve);
  const targetReserve = numberOrNull(s.target_reserve);
  if (!Number.isSafeInteger(holdId) || typeof s.status !== 'string' || originalReserve === null || targetReserve === null) {
    throw new Error('snapshot fields missing');
  }
  const terminal = s.status !== 'active';
  const contentState: LiveActivityContentState = {
    schema: CONTENT_SCHEMA, holdId, status: s.status, mode: stringOrNull(s.mode) ?? 'auto',
    phase: stringOrNull(monitoring.phase), originalReserve, targetReserve,
    estimatedLoadW: numberOrNull(monitoring.estimated_load_w),
    startedAt: swiftDate(startedMs)!, safetyExpiresAt: swiftDate(epochMs(s.safety_expires_at, 'safety_expires_at'))!,
    checkedAt: swiftDate(checkedMs), nextCheckAt: swiftDate(nextCheckMs), endedAt: swiftDate(endedMs),
    restoreReason: stringOrNull(s.restore_reason), cancelledObservedReserve: numberOrNull(s.cancelled_observed_reserve),
    sampledAt: swiftDate(optionalMs(monitoring.sampled_at, 'sampled_at')),
    baselineLoadW: numberOrNull(monitoring.baseline_load_w), homeLoadW: numberOrNull(monitoring.home_load_w),
    peakLoadW: numberOrNull(monitoring.peak_load_w),
    batteryPercent: numberOrNull(monitoring.battery_percent),
  };
  const aps: LiveActivityPayload['aps'] = {
    timestamp: unixSeconds(Math.max(startedMs, checkedMs ?? 0, endedMs ?? 0)),
    event: terminal ? 'end' : 'update',
    'content-state': contentState,
  };
  if (!terminal && nextCheckMs !== null) aps['stale-date'] = unixSeconds(nextCheckMs) + STALE_GRACE_S;
  // Updates don't spend the hourly ActivityKit budget; the final state is worth an immediate push.
  return { payload: { aps }, priority: terminal ? 10 : 5, expiration: unixSeconds(expiresAt.getTime()) };
}

/**
 * accepted: APNs took the request. That is not delivery: the device may be off,
 * the activity dismissed, or the token about to be reported unregistered.
 */
export type ApnsResult =
  | { kind: 'accepted'; apnsId: string | null }
  | { kind: 'invalid_token'; reason: string }
  | { kind: 'credentials'; reason: string }
  | { kind: 'transient'; reason: string }
  | { kind: 'rejected'; reason: string };

const INVALID_TOKEN = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'ExpiredToken', 'Unregistered']);
const CREDENTIALS = new Set([
  'BadCertificate', 'BadCertificateEnvironment', 'ExpiredProviderToken', 'Forbidden', 'InvalidProviderToken',
  'MissingProviderToken', 'UnrelatedKeyIdInToken', 'BadEnvironmentKeyIdInToken', 'TooManyProviderTokenUpdates',
  'TopicDisallowed', 'BadTopic', 'MissingTopic',
]);

function classify(status: number, reason: string | null, apnsId: string | null): ApnsResult {
  if (status === 200) return { kind: 'accepted', apnsId };
  const tag = reason ?? `http_${status}`;
  if (status === 410 || (reason && INVALID_TOKEN.has(reason))) return { kind: 'invalid_token', reason: tag };
  if (reason && CREDENTIALS.has(reason)) return { kind: 'credentials', reason: tag };
  if (status === 403) return { kind: 'credentials', reason: tag };
  if (status === 429 || status >= 500) return { kind: 'transient', reason: tag };
  return { kind: 'rejected', reason: tag };
}

export interface ApnsSendRequest extends LiveActivityRequest { environment: ApnsEnvironment; token: string }

export interface ApnsClientOptions {
  credentials: ApnsCredentials;
  /** Tests only; production always talks to APNS_ORIGINS. */
  origins?: Readonly<Record<ApnsEnvironment, string>>;
  requestTimeoutMs?: number;
}

/** One lazily opened HTTP/2 session per APNs environment for the lifetime of one delivery run. */
export class ApnsClient {
  private readonly sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();
  private readonly origins: Readonly<Record<ApnsEnvironment, string>>;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApnsClientOptions) {
    this.origins = options.origins ?? APNS_ORIGINS;
    this.timeoutMs = options.requestTimeoutMs ?? APNS_REQUEST_TIMEOUT_MS;
  }

  private session(environment: ApnsEnvironment): http2.ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(this.origins[environment]);
    // Failures surface on the request; a dead session is replaced on next use.
    const forget = () => { if (this.sessions.get(environment) === session) this.sessions.delete(environment); };
    session.on('error', forget);
    session.on('goaway', forget);
    session.on('close', forget);
    this.sessions.set(environment, session);
    return session;
  }

  /** Never throws and never outlives its deadline; the result carries no token or response body. */
  async send(request: ApnsSendRequest): Promise<ApnsResult> {
    if (!/^[0-9a-fA-F]{16,512}$/.test(request.token)) return { kind: 'invalid_token', reason: 'MalformedToken' };
    let authorization: string;
    try { authorization = `bearer ${providerToken(this.options.credentials)}`; }
    catch { return { kind: 'credentials', reason: 'InvalidSigningKey' }; }
    const body = JSON.stringify(request.payload);
    return new Promise<ApnsResult>(resolve => {
      let settled = false;
      let stream: http2.ClientHttp2Stream | undefined;
      const finish = (result: ApnsResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stream && !stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ kind: 'transient', reason: 'timeout' }), this.timeoutMs);
      try {
        stream = this.session(request.environment).request({
          ':method': 'POST',
          ':path': `/3/device/${request.token}`,
          authorization,
          'apns-push-type': 'liveactivity',
          'apns-topic': `${this.options.credentials.bundleId}.push-type.liveactivity`,
          'apns-priority': String(request.priority),
          'apns-expiration': String(request.expiration),
          'apns-id': randomUUID(),
          'content-type': 'application/json',
        });
      } catch {
        finish({ kind: 'transient', reason: 'connect' });
        return;
      }
      let status = 0;
      let apnsId: string | null = null;
      let response = '';
      stream.setEncoding('utf8');
      stream.on('response', headers => {
        status = Number(headers[':status']);
        const id = headers['apns-id'];
        apnsId = typeof id === 'string' && /^[0-9a-fA-F-]{36}$/.test(id) ? id : null;
      });
      stream.on('data', (chunk: string) => { if (response.length < 4096) response += chunk; });
      stream.on('end', () => {
        let reason: string | null = null;
        try {
          const parsed = JSON.parse(response) as { reason?: unknown };
          if (typeof parsed.reason === 'string' && /^[A-Za-z]{1,64}$/.test(parsed.reason)) reason = parsed.reason;
        } catch { /* empty or non-JSON body */ }
        finish(status ? classify(status, reason, apnsId) : { kind: 'transient', reason: 'no_response' });
      });
      stream.on('error', () => finish({ kind: 'transient', reason: 'transport' }));
      stream.on('close', () => finish(status ? classify(status, null, apnsId) : { kind: 'transient', reason: 'transport' }));
      stream.end(body);
    });
  }

  /** Closes every session; awaited so no connection outlives the delivery run. */
  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(session => new Promise<void>(resolve => {
      if (session.closed || session.destroyed) { resolve(); return; }
      const force = setTimeout(() => { session.destroy(); resolve(); }, 1000);
      session.close(() => { clearTimeout(force); resolve(); });
    })));
  }
}
