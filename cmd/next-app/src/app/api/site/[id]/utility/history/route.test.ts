import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import y2025 from '@/lib/urdb/__fixtures__/we-energies-effective-2025-07-01.json';
import weDefaults from '@/lib/urdb/__fixtures__/we-energies-defaults.json';
import optionBChain from '@/lib/urdb/__fixtures__/we-energies-option-b-chain.json';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), verifySiteAccess: vi.fn(),
  ratesEffectiveOn: vi.fn(), defaultRates: vi.fn(),
  getSiteUtilityContext: vi.fn(), getRatePlanHistoryInputs: vi.fn(),
  isCrossOriginRequest: vi.fn(), rateByLabel: vi.fn(), saveRatePlanHistory: vi.fn(),
}));
vi.mock('@/lib/request-security', () => ({ isCrossOriginRequest: mocks.isCrossOriginRequest }));
vi.mock('@/lib/urdb/estimate-job', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/urdb/estimate-job')>(),
  monthlyUsage: async () => null,
}));
vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: mocks.getCurrentUser, verifySiteAccess: mocks.verifySiteAccess }));
vi.mock('@/lib/io-deadline', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/io-deadline')>(),
  withIoDeadline: (_ms: number, action: () => Promise<unknown>) => action(),
}));
vi.mock('@/lib/observability', () => ({
  observeRoute: (_name: string, handler: (request: NextRequest, context: unknown) => Promise<Response>) => handler,
  errorFields: () => ({}), flushLogEvents: vi.fn(), logEvent: vi.fn(), setLogContext: vi.fn(),
}));
vi.mock('@/lib/urdb/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/urdb/client')>(),
  ratesEffectiveOn: mocks.ratesEffectiveOn, defaultRates: mocks.defaultRates, rateByLabel: mocks.rateByLabel,
}));
vi.mock('@/lib/tariff-timeline-repo', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/tariff-timeline-repo')>(),
  TariffTimelineRepo: class {
    getSiteUtilityContext = mocks.getSiteUtilityContext;
    getRatePlanHistoryInputs = mocks.getRatePlanHistoryInputs;
    saveRatePlanHistory = mocks.saveRatePlanHistory;
  },
}));

import { GET, PUT } from './route';
import { UrdbUnavailableError } from '@/lib/urdb/client';

const context = { params: Promise.resolve({ id: 'site-1' }) };
const request = () => new NextRequest('https://app.test/api/site/site-1/utility/history');
const window = { historyStart: '2023-11-14', fillThrough: '2026-04-27', unconfirmedDays: 900, askYears: [2025, 2024] };

describe('GET /api/site/[id]/utility/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.verifySiteAccess.mockResolvedValue(true);
    mocks.getSiteUtilityContext.mockResolvedValue({ name: 'Wisconsin Electric Power Co', timezone: 'America/Chicago' });
    mocks.getRatePlanHistoryInputs.mockResolvedValue({ window, tesla: null });
    mocks.ratesEffectiveOn.mockResolvedValue(y2025);
    mocks.defaultRates.mockResolvedValue(weDefaults);
  });
  it('rejectsWithoutUser', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect((await GET(request(), context)).status).toBe(401);
  });
  it('requiresUtility', async () => {
    mocks.getSiteUtilityContext.mockResolvedValueOnce({ name: null, timezone: 'America/Chicago' });
    const response = await GET(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Choose a utility first.' });
  });
  it('alreadyFilled', async () => {
    mocks.getRatePlanHistoryInputs.mockResolvedValueOnce({ window: null, tesla: null });
    const response = await GET(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Your rate plan history is already filled.' });
  });
  it('unavailableWithoutKey', async () => {
    mocks.ratesEffectiveOn.mockRejectedValueOnce(new UrdbUnavailableError('no key'));
    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Utility rates are unavailable right now.' });
  });
  it('returnsHistory', async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ utilityName: 'Wisconsin Electric Power Co', historyStart: '2023-11-14', fillThrough: '2026-04-27', teslaShape: null });
    expect(body.years.map((year: { year: number }) => year.year)).toEqual([2025, 2024]);
    expect(body.current.length).toBeGreaterThan(0);
    expect(body.current[0]).toHaveProperty('peakWindows');
  });
});

const OPTION_B = '685a177d100bd6b82a005dc0';
const put = (body: unknown) => new NextRequest('https://app.test/api/site/site-1/utility/history', {
  method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});

describe('PUT /api/site/[id]/utility/history', () => {
  const timeline = { siteId: 'site-1', periods: [] };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCrossOriginRequest.mockReturnValue(false);
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.verifySiteAccess.mockResolvedValue(true);
    mocks.getSiteUtilityContext.mockResolvedValue({ name: 'Wisconsin Electric Power Co', timezone: 'America/Chicago' });
    mocks.getRatePlanHistoryInputs.mockResolvedValue({ window, tesla: null });
    mocks.ratesEffectiveOn.mockResolvedValue(y2025);
    mocks.rateByLabel.mockImplementation(async (label: string) => [...optionBChain, ...y2025].find(rate => rate.label === label) ?? null);
    mocks.saveRatePlanHistory.mockResolvedValue(timeline);
  });
  it('crossOriginIsForbidden', async () => {
    mocks.isCrossOriginRequest.mockReturnValueOnce(true);
    expect((await PUT(put({ periods: [{ label: OPTION_B, from: '2025-06-01', to: '2026-04-27' }] }), context)).status).toBe(403);
    expect(mocks.saveRatePlanHistory).not.toHaveBeenCalled();
  });
  it('rejectsWithoutUser', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect((await PUT(put({ periods: [] }), context)).status).toBe(401);
  });
  it('rejectsOverlappingPeriods', async () => {
    const response = await PUT(put({ periods: [
      { label: OPTION_B, from: '2024-01-01', to: '2025-06-30' },
      { label: OPTION_B, from: '2025-06-01', to: '2026-04-27' },
    ] }), context);
    expect(response.status).toBe(400);
    expect(mocks.saveRatePlanHistory).not.toHaveBeenCalled();
  });
  it('rejectsInvalidPeriods', async () => {
    for (const periods of [
      [],
      [{ label: OPTION_B, from: '2025-06-01', to: '2025-05-01' }],
      [{ label: OPTION_B, from: '2025-02-30', to: '2025-05-01' }],
      [{ label: '', from: '2025-01-01', to: '2025-05-01' }],
      [{ label: OPTION_B, from: '2025-01-01', to: null }, { label: OPTION_B, from: '2025-06-01', to: '2025-07-01' }],
      [{ label: OPTION_B, from: '2025-06-01', to: '2025-07-01' }, { label: OPTION_B, from: '2025-01-01', to: '2025-05-01' }],
    ]) {
      expect((await PUT(put({ periods }), context)).status).toBe(400);
    }
    expect(mocks.saveRatePlanHistory).not.toHaveBeenCalled();
  });
  it('rejectsOpenPeriodWithTesla', async () => {
    const response = await PUT(put({ periods: [{ label: OPTION_B, from: '2025-06-01', to: null }] }), context);
    expect(response.status).toBe(400);
    expect(mocks.saveRatePlanHistory).not.toHaveBeenCalled();
  });
  it('rejectsMoreThanTwelve', async () => {
    const periods = Array.from({ length: 13 }, (_, index) => ({ label: OPTION_B, from: `${2010 + index}-01-01`, to: `${2010 + index}-12-31` }));
    const response = await PUT(put({ periods }), context);
    expect(response.status).toBe(400);
    expect(mocks.saveRatePlanHistory).not.toHaveBeenCalled();
  });
  it('rejectsALabelFromAnotherUtility', async () => {
    mocks.rateByLabel.mockResolvedValue({ ...y2025[0], utility: 'Madison Gas & Electric Co' });
    const response = await PUT(put({ periods: [{ label: OPTION_B, from: '2025-06-01', to: '2026-04-27' }] }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'That rate plan isn’t listed for your utility.' });
  });
  it('utilityChangedIsAConflict', async () => {
    const { UtilityChangedError } = await import('@/lib/tariff-timeline-repo');
    mocks.saveRatePlanHistory.mockRejectedValueOnce(new UtilityChangedError('x'));
    const response = await PUT(put({ periods: [{ label: OPTION_B, from: '2025-06-01', to: '2026-04-27' }] }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Utility changed. Start again.' });
  });
  it('unavailableIs503', async () => {
    mocks.rateByLabel.mockRejectedValueOnce(new UrdbUnavailableError('no key'));
    const response = await PUT(put({ periods: [{ label: OPTION_B, from: '2025-06-01', to: '2026-04-27' }] }), context);
    expect(response.status).toBe(503);
  });
  it('returnsTimelineWithETag', async () => {
    const response = await PUT(put({ periods: [
      { label: OPTION_B, from: '2024-01-01', to: '2024-12-31' },
      { label: OPTION_B, from: '2025-06-01', to: '2026-04-27' },
    ] }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(await response.json()).toEqual(timeline);
    const [siteId, userId, utility, revisions, openLabel] = mocks.saveRatePlanHistory.mock.calls[0];
    expect([siteId, userId, utility, openLabel]).toEqual(['site-1', 'user-1', 'Wisconsin Electric Power Co', null]);
    expect(revisions.map((r: { from: string; to: string }) => [r.from, r.to])).toEqual([['2024-01-01', '2024-12-31'], ['2025-06-01', '2026-04-27']]);
  });
  it('sendsTheOpenPeriodAsThePlanPick', async () => {
    mocks.getRatePlanHistoryInputs.mockResolvedValueOnce({ window: { ...window, fillThrough: null }, tesla: null });
    const response = await PUT(put({ periods: [
      { label: OPTION_B, from: '2024-01-01', to: '2024-12-31' },
      { label: OPTION_B, from: '2025-01-01', to: null },
    ] }), context);
    expect(response.status).toBe(200);
    const [, , , revisions, openLabel] = mocks.saveRatePlanHistory.mock.calls[0];
    expect(openLabel).toBe(OPTION_B);
    expect(revisions.every((r: { to: string | null }) => r.to !== null && r.to <= '2024-12-31')).toBe(true);
  });
});
