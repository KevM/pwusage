import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  APNS_ORIGINS, ApnsClient, apnsCredentialsFromEnv, buildLiveActivityRequest, providerToken, resetProviderTokenCache,
  type ApnsCredentials, type ApnsResult,
} from './battery-hold-apns';
import { apnsReply, startMockApns, type ApnsResponder } from './apns-mock-server';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CREDS: ApnsCredentials = { keyId: 'ABC123DEFG', teamId: '6HQGHHRK87', privateKey: PEM, bundleId: 'fm.rodeo.pwusage' };
const TOKEN = 'ab'.repeat(32);
// Swift's default JSONDecoder reads Date as seconds since 2001-01-01T00:00:00Z.
const REFERENCE_EPOCH_S = 978307200;

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  hold_id: 7, status: 'active', mode: 'auto', original_reserve: 20, target_reserve: 100,
  created_at: '2026-10-15T10:00:00.000Z', safety_expires_at: '2026-10-15T18:00:00.000Z',
  restored_at: null, restore_reason: null, cancelled_observed_reserve: null,
  monitoring: {
    phase: 'load_running', checked_at: '2026-10-15T10:15:02.500Z', next_check_at: '2026-10-15T10:30:00.000Z',
    sampled_at: '2026-10-15T10:10:00.000Z', estimated_load_w: 7200,
    baseline_load_w: 1200, home_load_w: 8400, peak_load_w: 9100,
  },
  ...overrides,
});
const EXPIRES = new Date('2026-10-15T22:00:00.000Z');

describe('apnsCredentialsFromEnv', () => {
  const env = { APNS_KEY_ID: CREDS.keyId, APNS_TEAM_ID: CREDS.teamId, APNS_PRIVATE_KEY: PEM };

  it('is null unless the key id, team id and signing key are all set', () => {
    expect(apnsCredentialsFromEnv({})).toBeNull();
    for (const missing of Object.keys(env)) {
      expect(apnsCredentialsFromEnv({ ...env, [missing]: '' })).toBeNull();
    }
  });

  it('defaults the bundle id and accepts a key pasted with escaped newlines', () => {
    const creds = apnsCredentialsFromEnv({ ...env, APNS_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') });
    expect(creds).toEqual({ ...CREDS, privateKey: PEM });
    expect(apnsCredentialsFromEnv({ ...env, APNS_BUNDLE_ID: 'com.example.app' })?.bundleId).toBe('com.example.app');
  });

  it('rejects malformed key or team ids', () => {
    expect(apnsCredentialsFromEnv({ ...env, APNS_KEY_ID: 'short' })).toBeNull();
    expect(apnsCredentialsFromEnv({ ...env, APNS_TEAM_ID: 'has space!' })).toBeNull();
  });
});

describe('providerToken', () => {
  afterEach(() => resetProviderTokenCache());

  it('is an ES256 JWT with kid, iss and iat that verifies against the public key', () => {
    const token = providerToken(CREDS, 1_800_000_000_000);
    const decoded = jwt.verify(token, publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      { algorithms: ['ES256'], complete: true, clockTimestamp: 1_800_000_000 });
    expect(decoded.header).toMatchObject({ alg: 'ES256', kid: CREDS.keyId });
    expect(decoded.payload).toEqual({ iss: CREDS.teamId, iat: 1_800_000_000 });
  });

  it('is reused for 30 minutes and then refreshed (Apple: 20 to 60 minutes)', () => {
    const first = providerToken(CREDS, 1_800_000_000_000);
    expect(providerToken(CREDS, 1_800_000_000_000 + 29 * 60_000)).toBe(first);
    const refreshed = providerToken(CREDS, 1_800_000_000_000 + 31 * 60_000);
    expect(refreshed).not.toBe(first);
    expect((jwt.decode(refreshed) as { iat: number }).iat).toBe(1_800_000_000 + 31 * 60);
  });

  it('is not shared across signing keys', () => {
    const first = providerToken(CREDS, 1_800_000_000_000);
    expect(providerToken({ ...CREDS, keyId: 'ZZZ123DEFG' }, 1_800_000_000_000)).not.toBe(first);
  });
});

describe('buildLiveActivityRequest', () => {
  it('maps an active hold to a low-priority update whose content state decodes with Swift defaults', () => {
    const request = buildLiveActivityRequest(snapshot(), EXPIRES);
    expect(request.priority).toBe(5);
    expect(request.expiration).toBe(EXPIRES.getTime() / 1000);
    const { aps } = request.payload;
    expect(aps.event).toBe('update');
    expect(aps.timestamp).toBe(Math.floor(Date.parse('2026-10-15T10:15:02.500Z') / 1000));
    expect(aps['stale-date']).toBe(Date.parse('2026-10-15T10:40:00.000Z') / 1000);
    expect(aps['dismissal-date']).toBeUndefined();
    expect(aps['content-state']).toEqual({
      schema: 1, holdId: 7, status: 'active', mode: 'auto', phase: 'load_running',
      originalReserve: 20, targetReserve: 100, estimatedLoadW: 7200,
      startedAt: Date.parse('2026-10-15T10:00:00.000Z') / 1000 - REFERENCE_EPOCH_S,
      safetyExpiresAt: Date.parse('2026-10-15T18:00:00.000Z') / 1000 - REFERENCE_EPOCH_S,
      checkedAt: Date.parse('2026-10-15T10:15:02.000Z') / 1000 - REFERENCE_EPOCH_S,
      nextCheckAt: Date.parse('2026-10-15T10:30:00.000Z') / 1000 - REFERENCE_EPOCH_S,
      endedAt: null, restoreReason: null, cancelledObservedReserve: null,
      sampledAt: Date.parse('2026-10-15T10:10:00.000Z') / 1000 - REFERENCE_EPOCH_S,
      baselineLoadW: 1200, homeLoadW: 8400, peakLoadW: 9100,
    });
  });

  it('sends null load figures for monitoring recorded before they existed', () => {
    const { phase, checked_at, next_check_at } = snapshot().monitoring;
    const request = buildLiveActivityRequest(snapshot({ monitoring: { phase, checked_at, next_check_at, sampled_at: null, estimated_load_w: null } }), EXPIRES);
    expect(request.payload.aps['content-state']).toMatchObject({ sampledAt: null, baselineLoadW: null, homeLoadW: null, peakLoadW: null });
  });

  it('maps a terminal hold to a high-priority end carrying the final content state', () => {
    const request = buildLiveActivityRequest(snapshot({
      status: 'cancelled', restored_at: '2026-10-15T11:00:00.000Z', restore_reason: 'reserve_changed', cancelled_observed_reserve: 55,
    }), EXPIRES);
    expect(request.priority).toBe(10);
    const { aps } = request.payload;
    expect(aps.event).toBe('end');
    expect(aps.timestamp).toBe(Date.parse('2026-10-15T11:00:00.000Z') / 1000);
    expect(aps['stale-date']).toBeUndefined();
    expect(aps['content-state']).toMatchObject({
      status: 'cancelled', restoreReason: 'reserve_changed', cancelledObservedReserve: 55,
      endedAt: Date.parse('2026-10-15T11:00:00.000Z') / 1000 - REFERENCE_EPOCH_S,
    });
  });

  it('orders the APNs timestamp by the data time, so a late older version cannot overwrite a newer one', () => {
    const older = buildLiveActivityRequest(snapshot(), EXPIRES);
    const newer = buildLiveActivityRequest(snapshot({ monitoring: { ...snapshot().monitoring, checked_at: '2026-10-15T10:30:01.000Z' } }), EXPIRES);
    const ended = buildLiveActivityRequest(snapshot({ status: 'restored', restored_at: '2026-10-15T10:31:00.000Z' }), EXPIRES);
    expect(older.payload.aps.timestamp).toBeLessThan(newer.payload.aps.timestamp);
    expect(newer.payload.aps.timestamp).toBeLessThan(ended.payload.aps.timestamp);
  });

  it('tolerates a hold that has never been checked and stays well under the 4 KB content limit', () => {
    const request = buildLiveActivityRequest(snapshot({ monitoring: null }), EXPIRES);
    expect(request.payload.aps.timestamp).toBe(Date.parse('2026-10-15T10:00:00.000Z') / 1000);
    expect(request.payload.aps['content-state']).toMatchObject({ phase: null, checkedAt: null, nextCheckAt: null, estimatedLoadW: null });
    expect(request.payload.aps['stale-date']).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(buildLiveActivityRequest(snapshot(), EXPIRES).payload))).toBeLessThan(1024);
  });

  it('refuses a snapshot it cannot represent', () => {
    expect(() => buildLiveActivityRequest({ ...snapshot(), created_at: 'not a date' }, EXPIRES)).toThrow();
    expect(() => buildLiveActivityRequest(null, EXPIRES)).toThrow();
  });
});

type Responder = ApnsResponder;
const mockApple = startMockApns;
const reply = apnsReply;

describe('ApnsClient', () => {
  const request = () => ({ environment: 'sandbox' as const, token: TOKEN, ...buildLiveActivityRequest(snapshot(), EXPIRES) });
  let apple: Awaited<ReturnType<typeof mockApple>> | undefined;
  let client: ApnsClient | undefined;

  afterEach(async () => {
    await client?.close();
    await apple?.close();
    client = apple = undefined;
    resetProviderTokenCache();
  });

  const setup = async (respond: Responder, timeoutMs = 2000) => {
    apple = await mockApple(respond);
    client = new ApnsClient({ credentials: CREDS, origins: { sandbox: apple.origin, production: apple.origin }, requestTimeoutMs: timeoutMs });
    return apple;
  };

  it('uses the Apple sandbox and production hosts by default', () => {
    expect(APNS_ORIGINS).toEqual({ sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' });
  });

  it('sends a token-authenticated Live Activity request with the topic and push-type headers', async () => {
    const mock = await setup(reply(200));
    const result = await client!.send(request());
    expect(result).toEqual({ kind: 'accepted', apnsId: 'eabeae54-14a8-11e5-b60b-1697f925ec7b' });
    const [{ headers, body }] = mock.received;
    expect(headers[':method']).toBe('POST');
    expect(headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(headers['apns-push-type']).toBe('liveactivity');
    expect(headers['apns-topic']).toBe('fm.rodeo.pwusage.push-type.liveactivity');
    expect(headers['apns-priority']).toBe('5');
    expect(headers['apns-expiration']).toBe(String(EXPIRES.getTime() / 1000));
    expect(headers['apns-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(headers.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(body)).toEqual(request().payload);
  });

  it('reuses one HTTP/2 session per environment and keeps environments apart', async () => {
    const sandbox = await mockApple(reply(200));
    const production = await mockApple(reply(200));
    client = new ApnsClient({ credentials: CREDS, origins: { sandbox: sandbox.origin, production: production.origin } });
    try {
      await client.send(request());
      await client.send(request());
      await client.send({ ...request(), environment: 'production' });
      expect(sandbox.received).toHaveLength(2);
      expect(production.received).toHaveLength(1);
      expect(sandbox.sessions.size).toBe(1);
      await client.close();
      await vi.waitFor(() => expect(sandbox.sessions.size + production.sessions.size).toBe(0));
    } finally {
      await sandbox.close();
      await production.close();
    }
  });

  it.each([
    [410, 'Unregistered', 'invalid_token'],
    [410, 'ExpiredToken', 'invalid_token'],
    [400, 'BadDeviceToken', 'invalid_token'],
    [400, 'DeviceTokenNotForTopic', 'invalid_token'],
    [403, 'InvalidProviderToken', 'credentials'],
    [403, 'ExpiredProviderToken', 'credentials'],
    [403, 'BadEnvironmentKeyIdInToken', 'credentials'],
    [403, 'Forbidden', 'credentials'],
    [400, 'TopicDisallowed', 'credentials'],
    [429, 'TooManyProviderTokenUpdates', 'credentials'],
    [429, 'TooManyRequests', 'transient'],
    [500, 'InternalServerError', 'transient'],
    [503, 'ServiceUnavailable', 'transient'],
    [413, 'PayloadTooLarge', 'rejected'],
    [400, 'BadPriority', 'rejected'],
  ] as const)('classifies %i %s as %s', async (status, reason, kind) => {
    await setup(reply(status, { reason }));
    expect(await client!.send(request())).toMatchObject({ kind, reason });
  });

  it('never echoes a response body that is not a plain Apple reason', async () => {
    await setup(reply(400, { reason: `Bad ${TOKEN}` }));
    const result = await client!.send(request());
    expect(result).toEqual({ kind: 'rejected', reason: 'http_400' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('times out a request that Apple never answers', async () => {
    await setup(() => undefined, 150);
    const started = Date.now();
    expect(await client!.send(request())).toEqual({ kind: 'transient', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports an unreachable endpoint as transient', async () => {
    const closed = net.createServer();
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as net.AddressInfo;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    client = new ApnsClient({ credentials: CREDS, origins: { sandbox: `http://127.0.0.1:${port}`, production: `http://127.0.0.1:${port}` }, requestTimeoutMs: 1000 });
    expect(await client.send(request())).toMatchObject({ kind: 'transient' });
  });

  it('reconnects after the server drops the session', async () => {
    const mock = await setup(reply(200));
    expect((await client!.send(request())).kind).toBe('accepted');
    for (const session of mock.sessions) session.destroy();
    await vi.waitFor(() => expect(mock.sessions.size).toBe(0));
    let result: ApnsResult = { kind: 'transient', reason: 'unsent' };
    for (let i = 0; i < 3 && result.kind !== 'accepted'; i++) result = await client!.send(request());
    expect(result.kind).toBe('accepted');
  });

  it('refuses a malformed device token without contacting Apple', async () => {
    const mock = await setup(reply(200));
    expect(await client!.send({ ...request(), token: `${TOKEN}/../../x` })).toEqual({ kind: 'invalid_token', reason: 'MalformedToken' });
    expect(mock.received).toHaveLength(0);
  });

  it('reports an unusable signing key as a credential failure without contacting Apple', async () => {
    const mock = await setup(reply(200));
    await client!.close();
    client = new ApnsClient({ credentials: { ...CREDS, privateKey: 'not a key' }, origins: { sandbox: mock.origin, production: mock.origin } });
    expect(await client.send(request())).toEqual({ kind: 'credentials', reason: 'InvalidSigningKey' });
    expect(mock.received).toHaveLength(0);
  });
});

describe('ApnsClient defaults', () => {
  let client: ApnsClient;
  beforeAll(() => { client = new ApnsClient({ credentials: CREDS }); });
  afterAll(async () => { await client.close(); });

  it('opens no connection until a request is sent', async () => {
    await expect(client.close()).resolves.toBeUndefined();
  });
});
