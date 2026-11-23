import { errorFields, logEvent, observeRoute, setLogContext } from '@/lib/observability';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Hobby caps maxDuration at 60 s; runBatteryHoldCron plans for 55 s.
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { runBatteryHoldCron } from '@/lib/battery-hold-cron-service';
import { activityErrorTag } from '@/lib/battery-hold-activity-repo';

// Battery Saver's one cron: checks every active hold, then sends the Live
// Activity updates that check (or a manual stop) produced.
async function handleGET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const run = await runBatteryHoldCron();
  const { monitor, delivery } = run;

  if (monitor) {
    setLogContext({ siteIds: monitor.results.map(result => result.siteId) });
    for (const result of monitor.results) logEvent(result.status === 'failed' ? 'warn' : 'info', 'cron.restore-reserve.site', result);
    logEvent('info', 'cron.restore-reserve.completed', { summary: monitor });
  } else {
    logEvent('error', 'cron.restore-reserve.failed', { error: errorFields(run.monitorError) });
  }

  if (run.deliveryError !== null) {
    logEvent('error', 'cron.activity-delivery.failed', { errorTag: activityErrorTag(run.deliveryError) });
  } else if (run.deliverySkipped) {
    logEvent('warn', 'cron.activity-delivery.skipped', { reason: 'monitor_used_budget' });
  } else if (delivery && delivery.status !== 'unconfigured' && delivery.status !== 'idle') {
    logEvent('info', 'cron.activity-delivery.completed', { summary: delivery });
  }

  return NextResponse.json({
    success: !run.failed,
    ...(monitor ? { monitor: { processed: monitor.eligible, ...monitor } } : { monitorError: 'Monitor unavailable' }),
    ...(delivery ? { delivery } : {}),
    ...(run.deliveryError !== null ? { deliveryError: 'Delivery unavailable' } : {}),
    ...(run.deliverySkipped ? { deliverySkipped: true } : {}),
    ...(delivery?.credentialFailure ? { error: 'APNs credentials rejected' } : {}),
  }, { status: run.failed ? 503 : 200 });
}

export const GET = observeRoute('/api/cron/restore-reserve', handleGET);
