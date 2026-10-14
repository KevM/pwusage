export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { BatteryHoldRepo } from '@/lib/battery-hold-repo';
import { monitorBatteryHolds } from '@/lib/battery-hold-monitor-service';
import { withIoDeadline } from '@/lib/io-deadline';

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const holds = await withIoDeadline(2000, () => new BatteryHoldRepo().getAllActiveHolds());
    const summary = await monitorBatteryHolds(holds);
    console.log('[CRON] restore-reserve', JSON.stringify(summary));
    return NextResponse.json({ success: true, processed: holds.length, ...summary });
  } catch {
    console.error('[CRON] restore-reserve could not load active holds');
    return NextResponse.json({ error: 'Monitor unavailable' }, { status: 503 });
  }
}
