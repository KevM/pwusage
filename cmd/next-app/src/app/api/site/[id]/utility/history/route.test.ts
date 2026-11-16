import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import y2025 from '@/lib/urdb/__fixtures__/we-energies-effective-2025-07-01.json';
import weDefaults from '@/lib/urdb/__fixtures__/we-energies-defaults.json';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), verifySiteAccess: vi.fn(),
  ratesEffectiveOn: vi.fn(), defaultRates: vi.fn(),
  getSiteUtilityContext: vi.fn(), getRatePlanHistoryInputs: vi.fn(),
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
  ratesEffectiveOn: mocks.ratesEffectiveOn, defaultRates: mocks.defaultRates,
}));
vi.mock('@/lib/tariff-timeline-repo', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/tariff-timeline-repo')>(),
  TariffTimelineRepo: class {
    getSiteUtilityContext = mocks.getSiteUtilityContext;
    getRatePlanHistoryInputs = mocks.getRatePlanHistoryInputs;
  },
}));

import { GET } from './route';
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
