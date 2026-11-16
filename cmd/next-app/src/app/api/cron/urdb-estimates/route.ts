import { NextRequest, NextResponse } from 'next/server';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, flushLogEvents, logEvent, observeRoute, setLogContext } from '@/lib/observability';
import { runUrdbEstimatesCron } from '@/lib/urdb/estimate-job';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

async function handleGET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    logEvent('info', 'cron.urdb-estimates.started');
    flushLogEvents();
    const summary = await withIoDeadline(50_000, () =>
      runUrdbEstimatesCron({ maxTimeMs: 40_000, maxSites: 5 })
    );
    setLogContext({ siteIds: summary.sites.map(site => site.siteId) });
    logEvent('info', 'cron.urdb-estimates.completed', {
      checked: summary.checked,
      ...(summary.stopped ? { stopped: summary.stopped } : {}),
      sites: summary.sites,
    });
    flushLogEvents();
    return NextResponse.json({ success: true, ...summary });
  } catch (error) {
    logEvent('error', 'cron.urdb-estimates.failed', { error: errorFields(error) });
    flushLogEvents();
    return NextResponse.json({ error: 'Utility rate estimates unavailable' }, { status: 503 });
  }
}

export const GET = observeRoute('/api/cron/urdb-estimates', handleGET);
