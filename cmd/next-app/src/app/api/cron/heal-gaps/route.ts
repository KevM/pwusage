import { flushLogEvents, logEvent, observeRoute, setLogContext } from '@/lib/observability';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Hobby caps maxDuration at 60 s. healTrailingGaps stops starting new sites at
// 35 s; the I/O deadline cancels a window that is still running at 50 s.
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { healTrailingGaps } from '@/lib/gap-heal';
import { withIoDeadline } from '@/lib/io-deadline';

const HARD_DEADLINE_MS = 50_000;

async function handleGET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    logEvent('info', 'cron.heal-gaps.started');
    flushLogEvents();
    const summary = await withIoDeadline(HARD_DEADLINE_MS, () => healTrailingGaps());
    setLogContext({ siteIds: summary.sites.map(site => site.siteId) });
    logEvent('info', 'cron.heal-gaps.completed', {
      checked: summary.checked, stopped: summary.stopped,
      sites: summary.sites.map(site => ({ siteId: site.siteId, status: site.status })),
    });
    return NextResponse.json({ success: true, ...summary });
  } catch (e) {
    logEvent('error', 'cron.heal-gaps.failed', { error: e });
    return NextResponse.json({ error: 'Gap heal unavailable' }, { status: 503 });
  }
}

export const GET = observeRoute('/api/cron/heal-gaps', handleGET);
