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
  const hold = await new BatteryHoldRepo().getActiveHold(id);
  return NextResponse.json({ hold });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await verifySiteAccess(id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const action = (body as { action?: string })?.action;
  if (action !== 'park' && action !== 'restore') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const client = await createSiteTeslaClient(id);
  if (!client) {
    return NextResponse.json({ error: 'needs_reauth' }, { status: 409 });
  }
  const repo = new BatteryHoldRepo();

  const result = action === 'park'
    ? await parkBattery({ client, repo, siteId: id })
    : await restoreBattery({ client, repo, siteId: id, reason: 'manual' });

  switch (result.status) {
    case 'ok':
    case 'already_active':
      return NextResponse.json({ status: result.status, hold: 'hold' in result ? result.hold : null });
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
