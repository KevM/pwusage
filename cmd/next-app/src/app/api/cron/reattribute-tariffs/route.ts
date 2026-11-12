import { NextRequest, NextResponse } from 'next/server';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, flushLogEvents, logEvent, observeRoute, setLogContext } from '@/lib/observability';
import { REATTRIBUTION_MAX_TIME_MS, runPendingReattributionsCron } from '@/lib/tariff-reattribution';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const HARD_DEADLINE_MS = 50_000;

async function handleGET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    logEvent('info', 'cron.reattribute-tariffs.started');
    flushLogEvents();
    const summary = await withIoDeadline(HARD_DEADLINE_MS, () =>
      runPendingReattributionsCron({ maxTimeMs: REATTRIBUTION_MAX_TIME_MS })
    );
    setLogContext({ siteIds: summary.sites.map(site => site.siteId) });
    logEvent('info', 'cron.reattribute-tariffs.completed', {
      checked: summary.checked,
      ...(summary.stopped ? { stopped: summary.stopped } : {}),
      sites: summary.sites.map(site => ({
        siteId: site.siteId,
        outcome: site.outcome,
        processedDays: site.processedDays,
        updatedDays: site.updatedDays,
      })),
    });
    flushLogEvents();
    return NextResponse.json({ success: true, ...summary });
  } catch (error) {
    logEvent('error', 'cron.reattribute-tariffs.failed', { error: errorFields(error) });
    flushLogEvents();
    return NextResponse.json({ error: 'Tariff re-attribution unavailable' }, { status: 503 });
  }
}

export const GET = observeRoute('/api/cron/reattribute-tariffs', handleGET);
