export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Hobby caps maxDuration at 60 s. healTrailingGaps stops starting new sites at
// 35 s; the I/O deadline cancels a window that is still running at 50 s.
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { healTrailingGaps } from '@/lib/gap-heal';
import { withIoDeadline } from '@/lib/io-deadline';

const HARD_DEADLINE_MS = 50_000;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const summary = await withIoDeadline(HARD_DEADLINE_MS, () => healTrailingGaps());
    console.log('[CRON] heal-gaps', JSON.stringify(summary));
    return NextResponse.json({ success: true, ...summary });
  } catch (e) {
    console.error('[CRON] heal-gaps unavailable', e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: 'Gap heal unavailable' }, { status: 503 });
  }
}
