import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyTrmnlToken: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/lib/trmnl-auth', () => ({
  verifyTrmnlToken: mocks.verifyTrmnlToken,
}));

vi.mock('@/lib/db', () => ({
  pool: {
    query: mocks.query,
  },
}));

import { POST as createHandoff } from './route';
import { POST as consumeHandoff } from './consume/route';
import { TRMNL_MANAGE_BINDING_COOKIE } from '@/lib/trmnl-manage-handoff';

describe('TRMNL manage handoff routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes a signed-out round trip and rejects replay and wrong-browser attempts', async () => {
    mocks.verifyTrmnlToken.mockResolvedValue({ sub: 'dev-1' });

    // In-memory store backing the DB queries for create + consume + replay
    const store = new Map<string, {
      id: string;
      device_uuid: string;
      browser_binding_hash: string;
      trmnl_token: string;
      consumed_at: Date | null;
      expires_at: Date;
    }>();

    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('DELETE FROM "TrmnlManageHandoff"')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO "TrmnlManageHandoff"')) {
        const [id, device_uuid, browser_binding_hash, trmnl_token] = params as [string, string, string, string];
        store.set(id, {
          id,
          device_uuid,
          browser_binding_hash,
          trmnl_token,
          consumed_at: null,
          expires_at: new Date(Date.now() + 600_000),
        });
        return { rows: [] };
      }
      if (sql.includes('UPDATE "TrmnlManageHandoff"')) {
        const [id, device_uuid, browser_binding_hash] = params as [string, string, string];
        const row = store.get(id);
        if (
          !row
          || row.device_uuid !== device_uuid
          || row.browser_binding_hash !== browser_binding_hash
          || row.consumed_at !== null
          || row.expires_at.getTime() <= Date.now()
        ) {
          return { rows: [] };
        }
        row.consumed_at = new Date();
        return { rows: [{ trmnl_token: row.trmnl_token }] };
      }
      return { rows: [] };
    });

    // 1. Initiate handoff before /login redirect
    const createReq = new NextRequest('https://pwusage.fm.rodeo/api/trmnl/manage/handoff', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://pwusage.fm.rodeo',
      },
      body: JSON.stringify({ uuid: 'dev-1', token: 'secret.trmnl.jwt' }),
    });
    const createRes = await createHandoff(createReq);
    expect(createRes.status).toBe(200);
    const { handoffId } = await createRes.json() as { handoffId: string };
    expect(handoffId).toMatch(/^[0-9a-f-]{36}$/i);

    const bindingCookie = createRes.cookies.get(TRMNL_MANAGE_BINDING_COOKIE);
    expect(bindingCookie?.value).toBeTruthy();
    expect(bindingCookie?.httpOnly).toBe(true);

    // 2. Wrong browser (missing or different binding cookie) cannot consume
    const wrongBrowserReq = new NextRequest('https://pwusage.fm.rodeo/api/trmnl/manage/handoff/consume', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://pwusage.fm.rodeo',
        cookie: `${TRMNL_MANAGE_BINDING_COOKIE}=wrong-binding`,
      },
      body: JSON.stringify({ handoffId, uuid: 'dev-1' }),
    });
    const wrongBrowserRes = await consumeHandoff(wrongBrowserReq);
    expect(wrongBrowserRes.status).toBe(401);

    // 3. Initiating browser consumes once and gets the token
    const consumeReq = new NextRequest('https://pwusage.fm.rodeo/api/trmnl/manage/handoff/consume', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://pwusage.fm.rodeo',
        cookie: `${TRMNL_MANAGE_BINDING_COOKIE}=${bindingCookie!.value}`,
      },
      body: JSON.stringify({ handoffId, uuid: 'dev-1' }),
    });
    const consumeRes = await consumeHandoff(consumeReq);
    expect(consumeRes.status).toBe(200);
    expect(await consumeRes.json()).toEqual({ token: 'secret.trmnl.jwt' });
    expect(consumeRes.cookies.get(TRMNL_MANAGE_BINDING_COOKIE)?.value).toBe('');

    // 4. Replay of the same handoff fails
    const replayReq = new NextRequest('https://pwusage.fm.rodeo/api/trmnl/manage/handoff/consume', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://pwusage.fm.rodeo',
        cookie: `${TRMNL_MANAGE_BINDING_COOKIE}=${bindingCookie!.value}`,
      },
      body: JSON.stringify({ handoffId, uuid: 'dev-1' }),
    });
    const replayRes = await consumeHandoff(replayReq);
    expect(replayRes.status).toBe(401);
  });

  it('rejects expired handoff state', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const consumeReq = new NextRequest('https://pwusage.fm.rodeo/api/trmnl/manage/handoff/consume', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://pwusage.fm.rodeo',
        cookie: `${TRMNL_MANAGE_BINDING_COOKIE}=some-binding`,
      },
      body: JSON.stringify({
        handoffId: '11111111-1111-4111-8111-111111111111',
        uuid: 'dev-1',
      }),
    });
    const res = await consumeHandoff(consumeReq);
    expect(res.status).toBe(401);
  });
});
