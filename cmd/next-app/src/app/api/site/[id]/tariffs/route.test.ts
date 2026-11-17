import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  afterCallbacks,
  getCurrentUserMock,
  verifySiteAccessMock,
  isCrossOriginMock,
  getTimelineMock,
  createManualPeriodMock,
  updatePeriodMock,
  deleteManualPeriodMock,
  enqueueMock,
  runSiteMock,
  poolQueryMock,
  poolConnectMock,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<unknown> | unknown>,
  getCurrentUserMock: vi.fn(),
  verifySiteAccessMock: vi.fn(),
  isCrossOriginMock: vi.fn(),
  getTimelineMock: vi.fn(),
  createManualPeriodMock: vi.fn(),
  updatePeriodMock: vi.fn(),
  deleteManualPeriodMock: vi.fn(),
  enqueueMock: vi.fn(),
  runSiteMock: vi.fn(),
  poolQueryMock: vi.fn(),
  poolConnectMock: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (cb: () => Promise<unknown> | unknown) => {
      afterCallbacks.push(cb);
    },
  };
});

vi.mock('@/lib/auth-checks', () => ({
  getCurrentUser: getCurrentUserMock,
  verifySiteAccess: verifySiteAccessMock,
}));

vi.mock('@/lib/request-security', () => ({
  isCrossOriginRequest: isCrossOriginMock,
}));

vi.mock('@/lib/observability', () => ({
  observeRoute: (_name: string, fn: () => Promise<Response>) => async () => fn(),
  setLogContext: vi.fn(),
  logEvent: vi.fn(),
  flushLogEvents: vi.fn(),
  accountFingerprint: (id: string) => `fp_${id}`,
  errorFields: (err: unknown) => ({ errorName: err instanceof Error ? err.name : 'Error' }),
}));

vi.mock('@/lib/io-deadline', () => ({
  withIoDeadline: async (_ms: number, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@/lib/tariff-reattribution', () => ({
  REATTRIBUTION_AFTER_MAX_TIME_MS: 6000,
  enqueueTariffReattribution: enqueueMock,
  runSiteReattribution: runSiteMock,
}));

vi.mock('@/lib/db', () => ({
  pool: { query: poolQueryMock, connect: poolConnectMock },
}));

vi.mock('@/lib/tariff-timeline-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tariff-timeline-repo')>();
  return {
    ...actual,
    TariffTimelineRepo: class {
      getTimeline = getTimelineMock;
      createManualPeriod = createManualPeriodMock;
      updatePeriod = updatePeriodMock;
      deleteManualPeriod = deleteManualPeriodMock;
    },
  };
});

import { GET, POST } from './route';
import { DELETE, PATCH } from './[periodId]/route';
import { POST as REATTRIBUTE_POST } from './reattribute/route';
import { TariffNotFoundError } from '@/lib/tariff-timeline-repo';
import { TariffValidationError } from '@/lib/tariff-timeline';

const timelineStub = {
  version: 2 as const,
  siteId: 'site-1',
  timezone: 'America/Chicago',
  currency: 'USD',
  periods: [],
  reattribution: null,
  teslaSync: {
    latestTariffId: 10,
    latestTariffName: 'We Energies',
    latestUpdatedAt: '2026-01-01T00:00:00.000Z',
    differsFromActiveManual: false,
  },
};

const reattributionStub = {
  status: 'pending' as const,
  fromDate: '2026-01-01',
  toDate: '2026-06-30',
  totalDays: 120,
  processedDays: 0,
  updatedDays: 0,
  lastError: null,
  updatedAt: '2026-06-01T00:00:00.000Z',
};

const validPayload = {
  name: 'We Energies Summer',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-06-30',
  seasons: [
    {
      name: 'All Year',
      fromMonth: 1,
      toMonth: 12,
      weekdayPeriods: [
        { touName: 'ON_PEAK', fromHour: 9, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: 0.30335, sellRate: 0.04906 },
        { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 9, toMinute: 0, buyRate: 0.14512, sellRate: 0.0329 },
      ],
      weekendPeriods: [
        { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.14512, sellRate: 0.0329 },
      ],
    },
  ],
};

describe('tariff timeline API routes', () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    vi.clearAllMocks();
    getCurrentUserMock.mockResolvedValue({ id: 'user-1' });
    verifySiteAccessMock.mockResolvedValue(true);
    isCrossOriginMock.mockReturnValue(false);
    getTimelineMock.mockResolvedValue(timelineStub);
    createManualPeriodMock.mockResolvedValue(timelineStub);
    updatePeriodMock.mockResolvedValue({
      timeline: timelineStub,
      affectedRange: { fromDate: '2026-01-01', toDate: '2026-06-30' },
    });
    deleteManualPeriodMock.mockResolvedValue({
      timeline: timelineStub,
      removedRange: { fromDate: '2026-01-01', toDate: '2026-06-30' },
    });
    enqueueMock.mockResolvedValue(reattributionStub);
    runSiteMock.mockResolvedValue({ outcome: 'idle', processedDays: 10, updatedDays: 10 });
    poolQueryMock.mockResolvedValue({ rows: [] });
  });

  it('GET returns 401 when unauthenticated or unauthorized', async () => {
    getCurrentUserMock.mockResolvedValueOnce(null);
    const res1 = await GET(new NextRequest('https://app.test/api/site/site-1/tariffs'), {
      params: Promise.resolve({ id: 'site-1' }),
    });
    expect(res1.status).toBe(401);

    verifySiteAccessMock.mockResolvedValueOnce(false);
    const res2 = await GET(new NextRequest('https://app.test/api/site/site-1/tariffs'), {
      params: Promise.resolve({ id: 'site-1' }),
    });
    expect(res2.status).toBe(401);
    expect(getTimelineMock).not.toHaveBeenCalled();
  });

  it('GET returns SiteTariffsTimelineResponse v2', async () => {
    const res = await GET(new NextRequest('https://app.test/api/site/site-1/tariffs'), {
      params: Promise.resolve({ id: 'site-1' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(await res.json()).toEqual(timelineStub);
    expect(getTimelineMock).toHaveBeenCalledWith('site-1', 'user-1');
  });

  it('GET sends an ETag and answers 304 when If-None-Match matches', async () => {
    const first = await GET(new NextRequest('https://app.test/api/site/site-1/tariffs'), {
      params: Promise.resolve({ id: 'site-1' }),
    });
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(first.headers.get('Cache-Control')).toBe('private, no-cache');

    const exact = await GET(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        headers: { 'If-None-Match': etag ?? '' },
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(exact.status).toBe(304);
    expect(exact.headers.get('ETag')).toBe(etag);
    expect(exact.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(await exact.text()).toBe('');

    const weak = await GET(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        headers: { 'If-None-Match': `W/${etag}` },
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(weak.status).toBe(304);
    expect(weak.headers.get('ETag')).toBe(etag);
  });

  it('ETag changes when a rate changes', async () => {
    const res1 = await GET(new NextRequest('https://app.test/api/site/site-1/tariffs'), {
      params: Promise.resolve({ id: 'site-1' }),
    });
    const etag1 = res1.headers.get('ETag');

    getTimelineMock.mockResolvedValueOnce({
      ...timelineStub,
      periods: [
        {
          id: 1,
          source: 'manual',
          name: 'Updated Plan',
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
          isCurrentToday: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
          seasons: [
            {
              id: 1,
              name: 'All Year',
              fromMonth: 1,
              fromDay: 1,
              toMonth: 12,
              toDay: 31,
              weekdayPeriods: [
                {
                  touName: 'ON_PEAK',
                  fromHour: 9,
                  fromMinute: 0,
                  toHour: 21,
                  toMinute: 0,
                  buyRate: 0.35,
                  sellRate: 0.05,
                },
              ],
              weekendPeriods: [],
            },
          ],
        },
      ],
    });
    const res2 = await GET(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        headers: { 'If-None-Match': etag1 ?? '' },
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(res2.status).toBe(200);
    expect(res2.headers.get('ETag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res2.headers.get('ETag')).not.toBe(etag1);
  });

  it('write routes return the ETag of their body', async () => {
    const { createHash } = await import('node:crypto');
    const hashOf = (text: string) => `"${createHash('sha256').update(text, 'utf8').digest('hex')}"`;

    const postRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        method: 'POST',
        body: JSON.stringify(validPayload),
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(postRes.status).toBe(201);
    expect(postRes.headers.get('ETag')).toBe(hashOf(await postRes.text()));

    const patchRes = await PATCH(
      new NextRequest('https://app.test/api/site/site-1/tariffs/5', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed' }),
      }),
      { params: Promise.resolve({ id: 'site-1', periodId: '5' }) }
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.headers.get('ETag')).toBe(hashOf(await patchRes.text()));

    const delRes = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/5', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '5' }) }
    );
    expect(delRes.status).toBe(200);
    expect(delRes.headers.get('ETag')).toBe(hashOf(await delRes.text()));

    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ timezone: 'America/Chicago' }] })
      .mockResolvedValueOnce({ rows: [{ from_date: '2025-05-01', to_date: null }] });
    const reattrRes = await REATTRIBUTE_POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs/reattribute', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(reattrRes.status).toBe(200);
    expect(reattrRes.headers.get('ETag')).toBe(hashOf(await reattrRes.text()));
  });

  it('POST / PATCH / DELETE / reattribute reject cross-origin requests with 403', async () => {
    isCrossOriginMock.mockReturnValue(true);

    const postRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(postRes.status).toBe(403);

    const patchRes = await PATCH(
      new NextRequest('https://app.test/api/site/site-1/tariffs/5', { method: 'PATCH', body: '{}' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '5' }) }
    );
    expect(patchRes.status).toBe(403);

    const delRes = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/5', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '5' }) }
    );
    expect(delRes.status).toBe(403);

    const reattrRes = await REATTRIBUTE_POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs/reattribute', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(reattrRes.status).toBe(403);
    expect(createManualPeriodMock).not.toHaveBeenCalled();
  });

  it('POST returns 400 on TariffValidationError and 201 on valid 5-decimal payload with after() drain', async () => {
    createManualPeriodMock.mockRejectedValueOnce(new TariffValidationError('Missing season coverage'));
    const badRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        method: 'POST',
        body: JSON.stringify(validPayload),
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(badRes.status).toBe(400);
    expect(enqueueMock).not.toHaveBeenCalled();

    const okRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        method: 'POST',
        body: JSON.stringify(validPayload),
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(okRes.status).toBe(201);
    const body = await okRes.json();
    expect(body).toMatchObject({ version: 2 });
    // The job is queued by the repo inside the mutation's transaction, not by the route.
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(runSiteMock).toHaveBeenCalledWith({ siteId: 'site-1', trigger: 'after', maxTimeMs: 6000 });
  });

  it('PATCH and DELETE enforce manual rules (400 on tesla, 404 on missing) and schedule after()', async () => {
    updatePeriodMock.mockRejectedValueOnce(new TariffValidationError('Tesla-synced rate plans only allow adjusting effective dates'));
    const teslaPatch = await PATCH(
      new NextRequest('https://app.test/api/site/site-1/tariffs/9', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed' }),
      }),
      { params: Promise.resolve({ id: 'site-1', periodId: '9' }) }
    );
    expect(teslaPatch.status).toBe(400);

    deleteManualPeriodMock.mockRejectedValueOnce(new TariffNotFoundError('Rate plan period not found'));
    const missingDel = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/999', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '999' }) }
    );
    expect(missingDel.status).toBe(404);

    deleteManualPeriodMock.mockRejectedValueOnce(new TariffValidationError('Only custom rate plan periods can be deleted'));
    const teslaDel = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/2', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '2' }) }
    );
    expect(teslaDel.status).toBe(400);

    const okDel = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/5', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '5' }) }
    );
    expect(okDel.status).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
  });

  it('POST /reattribute resets and enqueues reattribution then runs after()', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ timezone: 'America/Chicago' }] })
      .mockResolvedValueOnce({ rows: [{ from_date: '2025-05-01', to_date: null }] });
    const res = await REATTRIBUTE_POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs/reattribute', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledWith({
      siteId: 'site-1',
      fromDate: '2025-05-01',
      toDate: null,
      requestedByUserId: 'user-1',
      trigger: 'retry',
    });
    expect(afterCallbacks).toHaveLength(1);
  });

  it('refuses deleting an estimated period with the replacement guidance', async () => {
    deleteManualPeriodMock.mockRejectedValueOnce(new TariffValidationError(
      'Estimated rate plans fill days without a plan. Add your rate plan to replace one.'
    ));
    const response = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/12', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '12' }) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Estimated rate plans fill days without a plan. Add your rate plan to replace one.',
    });
    expect(afterCallbacks).toHaveLength(0);
  });

  it('enforces selection protection across legacy POST /tariffs, PATCH /tariffs/[id], and DELETE /tariffs/[id]', async () => {
    const actualMod = await vi.importActual<typeof import('@/lib/tariff-timeline-repo')>('@/lib/tariff-timeline-repo');
    const actualRepo = new actualMod.TariffTimelineRepo();
    const queries: string[] = [];
    let existingPeriods: Array<{
      id: number;
      tariff_id: number;
      source: 'tesla' | 'manual' | 'estimated';
      effective_from: string;
      effective_to: string | null;
      updated_by_user_id: string | null;
      selection_id: number | null;
      choice_kind: 'automatic' | 'owner' | null;
    }> = [];

    const fakeClient = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ timezone: 'America/Chicago' }] };
        }
        if (sql.includes('COALESCE(MAX(version), 0) + 1')) return { rows: [{ next: 4 }] };
        if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 109 }] };
        if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 209 }] };
        if (sql.includes('FROM "TariffEffectivePeriod" p') && sql.includes('ORDER BY effective_from ASC')) {
          return { rows: existingPeriods };
        }
        if (sql.includes('FROM "Tariff"') && sql.includes('id = ANY')) {
          return {
            rows: [{
              id: 77,
              site_id: 'site-1',
              version: 2,
              name: 'Public TOU',
              is_current: true,
              updated: new Date(),
              content_hash: 'h-pub',
              source: 'estimated',
            }],
          };
        }
        if (sql.includes('FROM "TariffSeason"')) {
          return {
            rows: [{
              id: 700, tariff_id: 77, name: 'All Year',
              from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.2, sell_rate: 0.05,
            }],
          };
        }
        if (sql.includes('FROM "TariffSchedule"')) {
          return {
            rows: [{
              id: 800, season_id: 700, name: 'OFF_PEAK', buy_rate: 0.2, sell_rate: 0.05,
              from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
            }],
          };
        }
        if (sql.includes('FROM "TariffSelection" WHERE id = $1')) {
          return {
            rows: [{
              urdb_label: 'urdb-pub-1',
              utility_name: 'We Energies',
              revision_start: '2026-01-01',
              export_rate_provenance: 'published',
              holidays_use_weekend: true,
              approximation_notes: [],
            }],
          };
        }
        if (sql.includes('INSERT INTO "TariffEffectivePeriod"')) return { rows: [{ id: 12 }] };
        if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
          return {
            rows: [{
              site_id: 'site-1',
              status: 'pending',
              generation: 1,
              from_date: '2026-01-01',
              to_date: '2026-06-30',
              cursor_day_start: null,
              total_days: 120,
              processed_days: 0,
              updated_days: 0,
              attempt_count: 0,
              last_error: null,
              requested_by_user_id: 'user-1',
              updated_at: new Date('2026-06-01T00:00:00.000Z'),
            }],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    poolConnectMock.mockResolvedValue(fakeClient);
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return { rows: [{ id: 'site-1', timezone: 'America/Chicago', installed: '2024-01-01T00:00:00Z', currency: 'USD' }] };
      }
      if (sql.includes('FROM "TariffEffectivePeriod" p')) {
        return {
          rows: existingPeriods.map(p => ({
            period_id: p.id,
            tariff_id: p.tariff_id,
            effective_from: p.effective_from,
            effective_to: p.effective_to,
            source: p.source,
            updated_by_user_id: p.updated_by_user_id,
            updated_by_email: p.updated_by_user_id ? 'owner@example.com' : null,
            name: 'Public TOU',
            version: 2,
            content_hash: 'h-pub',
            selection_id: p.selection_id,
            choice_kind: p.choice_kind,
            candidate_kind: p.source === 'estimated' ? 'public' : 'manual',
            selected_by_user_id: p.updated_by_user_id,
            urdb_label: p.source === 'estimated' ? 'urdb-pub-1' : null,
            utility_name: p.source === 'estimated' ? 'We Energies' : null,
            revision_start: '2026-01-01',
            export_rate_provenance: p.source === 'estimated' ? 'published' : 'manual',
            holidays_use_weekend: true,
            approximation_notes: [],
          })),
        };
      }
      return { rows: [] };
    });

    createManualPeriodMock.mockImplementation((...args: Parameters<typeof actualRepo.createManualPeriod>) =>
      actualRepo.createManualPeriod(...args)
    );
    updatePeriodMock.mockImplementation((...args: Parameters<typeof actualRepo.updatePeriod>) =>
      actualRepo.updatePeriod(...args)
    );
    deleteManualPeriodMock.mockImplementation((...args: Parameters<typeof actualRepo.deleteManualPeriod>) =>
      actualRepo.deleteManualPeriod(...args)
    );

    // 1. Overlapping an owner-selected public plan via legacy POST /tariffs MUST be refused (400).
    existingPeriods = [{
      id: 21, tariff_id: 77, source: 'estimated',
      effective_from: '2026-01-01', effective_to: null,
      updated_by_user_id: 'user-1', selection_id: 501, choice_kind: 'owner',
    }];
    const postPublicRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        method: 'POST',
        body: JSON.stringify(validPayload),
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(postPublicRes.status).toBe(400);
    expect(queries.some(q => q.includes('INSERT INTO "TariffEffectivePeriod"'))).toBe(false);
    expect(queries).toContain('ROLLBACK');
    expect(afterCallbacks).toHaveLength(0);

    // 2. Overlapping a restored saved Tesla plan (source='tesla', choice_kind='owner') via POST /tariffs MUST be refused (400).
    queries.length = 0;
    existingPeriods = [{
      id: 22, tariff_id: 50, source: 'tesla',
      effective_from: '2026-01-01', effective_to: null,
      updated_by_user_id: 'user-1', selection_id: 502, choice_kind: 'owner',
    }];
    const postRestoredTeslaRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        method: 'POST',
        body: JSON.stringify(validPayload),
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(postRestoredTeslaRes.status).toBe(400);
    expect(queries.some(q => q.includes('INSERT INTO "TariffEffectivePeriod"'))).toBe(false);
    expect(afterCallbacks).toHaveLength(0);

    // 3. Deleting an owner-selected public plan via legacy DELETE /tariffs/[periodId] MUST be refused (400).
    queries.length = 0;
    existingPeriods = [{
      id: 21, tariff_id: 77, source: 'estimated',
      effective_from: '2026-01-01', effective_to: null,
      updated_by_user_id: 'user-1', selection_id: 501, choice_kind: 'owner',
    }];
    const deletePublicRes = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/21', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '21' }) }
    );
    expect(deletePublicRes.status).toBe(400);
    expect(queries.some(q => q.includes('DELETE FROM "TariffEffectivePeriod"'))).toBe(false);
    expect(afterCallbacks).toHaveLength(0);

    // 4. Editing rates/name of an owner-selected public plan via legacy PATCH MUST be refused (400),
    // while extending an unrelated manual period over a protected selection MUST also be refused (400).
    const patchPublicRatesRes = await PATCH(
      new NextRequest('https://app.test/api/site/site-1/tariffs/21', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Stripped To Manual' }),
      }),
      { params: Promise.resolve({ id: 'site-1', periodId: '21' }) }
    );
    expect(patchPublicRatesRes.status).toBe(400);
    expect(afterCallbacks).toHaveLength(0);

    existingPeriods = [
      {
        id: 20, tariff_id: 66, source: 'manual',
        effective_from: '2025-01-01', effective_to: '2025-12-31',
        updated_by_user_id: 'user-1', selection_id: 500, choice_kind: 'owner',
      },
      {
        id: 21, tariff_id: 77, source: 'estimated',
        effective_from: '2026-01-01', effective_to: null,
        updated_by_user_id: 'user-1', selection_id: 501, choice_kind: 'owner',
      },
    ];
    const patchOverlapProtectedRes = await PATCH(
      new NextRequest('https://app.test/api/site/site-1/tariffs/20', {
        method: 'PATCH',
        body: JSON.stringify({ effectiveTo: '2026-03-31' }),
      }),
      { params: Promise.resolve({ id: 'site-1', periodId: '20' }) }
    );
    expect(patchOverlapProtectedRes.status).toBe(400);
    expect(afterCallbacks).toHaveLength(0);

    // 5. Legacy POST /tariffs still succeeds for old clients when overlapping only automatic Tesla spans.
    queries.length = 0;
    existingPeriods = [{
      id: 10, tariff_id: 44, source: 'tesla',
      effective_from: '2025-01-01', effective_to: null,
      updated_by_user_id: null, selection_id: null, choice_kind: 'automatic',
    }];
    const legacyAutoPostRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        method: 'POST',
        body: JSON.stringify(validPayload),
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(legacyAutoPostRes.status).toBe(201);
    expect(queries).toContain('COMMIT');
    expect(afterCallbacks).toHaveLength(1);
  });
});
