import { flushLogEvents, logEvent, observeRoute, setLogContext } from '@/lib/observability';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Hobby caps maxDuration at 60 s. runDueDetections stops starting new sites at
// 35 s and each detection carries a 48 s deadline; the I/O deadline cancels a
// day-record read that is still running at 50 s.
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { withIoDeadline } from '@/lib/io-deadline';
import { SolarLayoutRepo } from '@/lib/solar-layout-repo';
import { runDueDetections } from '@/lib/solar-layout/run-detections';

const BUDGET_MS = 35_000;
const HARD_DEADLINE_MS = 50_000;

async function loadSamples(siteId: string, timeZone: string, start: Date, end: Date) {
  const rows = await createEnergyRepo(timeZone).getRawEnergyData(siteId, start, end);
  return rows.map(row => ({ timestamp: row.timestamp, solarWh: row.solar_power }));
}

async function handleGET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    logEvent('info', 'cron.detect-solar-layouts.started');
    flushLogEvents();
    const summary = await withIoDeadline(HARD_DEADLINE_MS, () => runDueDetections({
      now: new Date(), budgetMs: BUDGET_MS, repo: new SolarLayoutRepo(), loadSamples,
    }));
    setLogContext({ siteIds: summary.sites.map(site => site.siteId) });
    logEvent('info', 'cron.detect-solar-layouts.completed', { stopped: summary.stopped, sites: summary.sites });
    return NextResponse.json({ success: true, ...summary });
  } catch (e) {
    logEvent('error', 'cron.detect-solar-layouts.failed', { error: e });
    return NextResponse.json({ error: 'Solar layout detection unavailable' }, { status: 503 });
  }
}

export const GET = observeRoute('/api/cron/detect-solar-layouts', handleGET);
