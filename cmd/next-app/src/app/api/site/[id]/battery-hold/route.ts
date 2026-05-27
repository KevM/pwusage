export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { BatteryHoldRepo } from '@/lib/battery-hold-repo';
import { createSiteTeslaClient, parkBattery, restoreBattery } from '@/lib/battery-hold-service';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await verifySiteAccess(id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const repo = new BatteryHoldRepo();
  const [hold, notice] = await Promise.all([repo.getActiveHold(id), repo.getLatestCancelledUnacked(id)]);
  return NextResponse.json({ hold, notice });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await verifySiteAccess(id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as {
    action?: string; mode?: string; durationHours?: unknown; reserveChoice?: unknown;
  };
  const action = body?.action;
  const repo = new BatteryHoldRepo();

  if (action === 'dismiss') {
    const notice = await repo.getLatestCancelledUnacked(id);
    if (notice) await repo.acknowledge(notice.id);
    return NextResponse.json({ status: 'ok' });
  }

  if (action !== 'park' && action !== 'restore') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  let mode: 'auto' | 'timer' = 'auto';
  let durationHours: number | undefined;
  let reserveChoice: 80 | 100 | undefined;
  if (action === 'park') {
    mode = body?.mode === 'timer' ? 'timer' : 'auto';
    if (mode === 'timer') {
      const h = Number(body?.durationHours);
      if (!Number.isInteger(h) || h < 1 || h > 24) {
        return NextResponse.json({ error: 'invalid_duration' }, { status: 400 });
      }
      durationHours = h;
    }
    if (body?.reserveChoice === 80 || body?.reserveChoice === 100) {
      reserveChoice = body.reserveChoice;
    }
  }

  const client = await createSiteTeslaClient(id);
  if (!client) {
    return NextResponse.json({ error: 'needs_reauth' }, { status: 409 });
  }

  const result = action === 'park'
    ? await parkBattery({ client, repo, siteId: id, mode, durationHours, reserveChoice })
    : await restoreBattery({ client, repo, siteId: id, reason: 'manual' });

  switch (result.status) {
    case 'ok':
    case 'already_active':
      return NextResponse.json({ status: result.status, hold: 'hold' in result ? result.hold : null });
    case 'reserve_changed':
      return NextResponse.json({ status: 'reserve_changed', current: result.current });
    case 'needs_choice':
      return NextResponse.json({ error: 'needs_choice', options: result.options }, { status: 422 });
    case 'no_active_hold':
      return NextResponse.json({ error: 'no_active_hold' }, { status: 409 });
    case 'no_soc':
      return NextResponse.json({ error: 'no_soc' }, { status: 422 });
    case 'needs_reauth':
      return NextResponse.json({ error: 'needs_reauth' }, { status: 409 });
    default:
      return NextResponse.json({ error: result.message }, { status: 500 });
  }
}
