import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  pool: {
    query: mocks.query,
  },
}));

import {
  consumeTrmnlManageHandoff,
  createTrmnlManageHandoff,
} from './trmnl-manage-handoff';

describe('trmnl-manage-handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a bounded server-side handoff with hashed browser binding', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const result = await createTrmnlManageHandoff({
      deviceUuid: 'dev-uuid-1',
      trmnlToken: 'trmnl.jwt.secret',
    });

    expect(result.handoffId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.browserBinding.length).toBeGreaterThan(20);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0][0]).toContain('DELETE FROM "TrmnlManageHandoff"');
    expect(mocks.query.mock.calls[1][0]).toContain('INSERT INTO "TrmnlManageHandoff"');
    const insertParams = mocks.query.mock.calls[1][1] as unknown[];
    expect(insertParams[0]).toBe(result.handoffId);
    expect(insertParams[1]).toBe('dev-uuid-1');
    // Stored binding is hashed, not raw browserBinding
    expect(insertParams[2]).not.toBe(result.browserBinding);
    expect(String(insertParams[2])).toMatch(/^[a-f0-9]{64}$/);
    expect(insertParams[3]).toBe('trmnl.jwt.secret');
  });

  it('consumes a valid handoff once and enforces expiry, device, and browser binding in SQL', async () => {
    const handoffId = '11111111-1111-4111-8111-111111111111';
    mocks.query.mockResolvedValueOnce({ rows: [{ trmnl_token: 'trmnl.jwt.secret' }] });

    const token = await consumeTrmnlManageHandoff({
      handoffId,
      deviceUuid: 'dev-uuid-1',
      browserBinding: 'binding-secret',
    });
    expect(token).toBe('trmnl.jwt.secret');
    expect(mocks.query.mock.calls[0][0]).toContain('expires_at > now()');
    expect(mocks.query.mock.calls[0][0]).toContain('consumed_at IS NULL');

    // Replay or expired/wrong binding returns 0 rows -> null
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const replay = await consumeTrmnlManageHandoff({
      handoffId,
      deviceUuid: 'dev-uuid-1',
      browserBinding: 'binding-secret',
    });
    expect(replay).toBeNull();
  });

  it('rejects invalid handoff IDs without querying the DB', async () => {
    const result = await consumeTrmnlManageHandoff({
      handoffId: 'not-a-uuid',
      deviceUuid: 'dev-uuid-1',
      browserBinding: 'binding-secret',
    });
    expect(result).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
