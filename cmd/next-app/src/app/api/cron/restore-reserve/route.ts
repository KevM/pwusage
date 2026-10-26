import { logEvent, observeRoute, setLogContext } from '@/lib/observability';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { BatteryHoldRepo } from '@/lib/battery-hold-repo';
import { monitorBatteryHolds } from '@/lib/battery-hold-monitor-service';
import { withIoDeadline } from '@/lib/io-deadline';

async function handleGET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const holds = await withIoDeadline(2000, () => new BatteryHoldRepo().getAllActiveHolds());
    setLogContext({ siteIds: holds.map(hold => hold.site_id) });
    const summary = await monitorBatteryHolds(holds);
    for (const result of summary.results) logEvent(result.status === 'failed' ? 'warn' : 'info', 'cron.restore-reserve.site', result);
    logEvent('info', 'cron.restore-reserve.completed', { summary });
    return NextResponse.json({ success: true, processed: holds.length, ...summary });
  } catch (error) {
    logEvent('error', 'cron.restore-reserve.failed', { error });
    return NextResponse.json({ error: 'Monitor unavailable' }, { status: 503 });
  }
}

export const GET = observeRoute('/api/cron/restore-reserve', handleGET);
