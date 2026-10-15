export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Its own invocation and budget, separate from the 60 s battery monitor.
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { deliverBatteryHoldActivities } from '@/lib/battery-hold-activity-delivery-service';
import { activityErrorTag } from '@/lib/battery-hold-activity-repo';

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const summary = await deliverBatteryHoldActivities();
    if (summary.status !== 'unconfigured' && summary.status !== 'idle') {
      console.log('[CRON] battery-hold-activity-delivery', JSON.stringify(summary));
    }
    if (summary.credentialFailure) {
      return NextResponse.json({ error: 'APNs credentials rejected', ...summary }, { status: 503 });
    }
    return NextResponse.json({ success: true, ...summary });
  } catch (e) {
    console.error('[CRON] battery-hold-activity-delivery unavailable', activityErrorTag(e));
    return NextResponse.json({ error: 'Delivery unavailable' }, { status: 503 });
  }
}
