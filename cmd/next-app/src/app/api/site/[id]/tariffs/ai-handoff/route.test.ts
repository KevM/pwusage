import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  verifySiteAccess: vi.fn(),
  getTimeline: vi.fn(),
  previewAiRatePlanHandoff: vi.fn(),
  commitAiRatePlanHandoff: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({
  getCurrentUser: mocks.getCurrentUser,
  verifySiteAccess: mocks.verifySiteAccess,
}));

vi.mock('@/lib/tariff-timeline-repo', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/tariff-timeline-repo')>();
  return {
    ...actual,
    TariffTimelineRepo: class {
      getTimeline = mocks.getTimeline;
    },
  };
});

vi.mock('@/lib/tariff-ai-handoff-service', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/tariff-ai-handoff-service')>();
  return {
    ...actual,
    previewAiRatePlanHandoff: mocks.previewAiRatePlanHandoff,
    commitAiRatePlanHandoff: mocks.commitAiRatePlanHandoff,
  };
});

vi.mock('@/lib/urdb/start-estimates', () => ({
  startPendingEstimates: vi.fn(),
}));

import { GET } from './route';
import { POST as PREVIEW_POST } from './preview/route';
import { POST as COMMIT_POST } from './commit/route';
import { TariffAiHandoffConflictError } from '@/lib/tariff-ai-handoff-service';

describe('/api/site/[id]/tariffs/ai-handoff routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
    mocks.verifySiteAccess.mockResolvedValue(true);
  });

  it('returns 401 when unauthorized on GET', async () => {
    mocks.verifySiteAccess.mockResolvedValueOnce(false);
    const req = new NextRequest('http://localhost/api/site/site-1/tariffs/ai-handoff');
    const res = await GET(req, { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(401);
  });

  it('exports markdown on GET', async () => {
    mocks.getTimeline.mockResolvedValueOnce({
      version: 2,
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      periods: [],
      referencePeriods: [],
      estimates: null,
      battery: null,
      systemCosts: { siteInstalled: '2023-01-01', solar: null, powerwall: null },
      reattribution: null,
      holidayDates: [],
      teslaSync: { latestTariffId: null, latestTariffName: null, latestUpdatedAt: null, differsFromActiveManual: false },
    });
    const req = new NextRequest('http://localhost/api/site/site-1/tariffs/ai-handoff');
    const res = await GET(req, { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBe('pwusage-rate-plan-check.md');
    expect(body.markdown).toContain('pwusage-rate-plan-handoff/v1');
  });

  it('returns preview on POST /preview', async () => {
    mocks.previewAiRatePlanHandoff.mockResolvedValueOnce({
      reviewHash: 'hash-1',
      siteId: 'site-1',
      currency: 'USD',
      unit: 'kWh',
      timezone: 'America/Chicago',
      notes: [],
      sources: [],
      unchangedActualCount: 0,
      unchangedReferenceCount: 0,
      actualPreviews: [],
      referencePreviews: [],
      recalculatesHistory: false,
      recalculatesFromHistoryStart: false,
      recalculationRange: null,
      affectsPowerwallPlan: false,
    });
    const req = new NextRequest('http://localhost/api/site/site-1/tariffs/ai-handoff/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ rawInput: '{}' }),
    });
    const res = await PREVIEW_POST(req, { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reviewHash).toBe('hash-1');
  });

  it('returns 409 REVIEW_STALE with fresh preview when commit conflicts', async () => {
    const stalePreview = {
      reviewHash: 'fresh-hash',
      siteId: 'site-1',
      currency: 'USD',
      unit: 'kWh' as const,
      timezone: 'America/Chicago',
      notes: [],
      sources: [],
      unchangedActualCount: 0,
      unchangedReferenceCount: 0,
      actualPreviews: [],
      referencePreviews: [],
      recalculatesHistory: false,
      recalculatesFromHistoryStart: false,
      recalculationRange: null,
      affectsPowerwallPlan: false as const,
    };
    mocks.commitAiRatePlanHandoff.mockRejectedValueOnce(new TariffAiHandoffConflictError(stalePreview));

    const req = new NextRequest('http://localhost/api/site/site-1/tariffs/ai-handoff/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ rawInput: '{}', expectedReviewHash: 'old-hash', verifiedAgainstBill: false }),
    });
    const res = await COMMIT_POST(req, { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('REVIEW_STALE');
    expect(data.preview.reviewHash).toBe('fresh-hash');
  });
});
