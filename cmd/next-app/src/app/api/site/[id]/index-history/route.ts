export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { SiteRepo } from '@/lib/site-repo';
import { RollupBackfillRepo } from '@/lib/battery-provenance/rollup-backfill-repo';
import { localDateKey } from '@/lib/battery-provenance/local-day';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await verifySiteAccess(id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const site = await new SiteRepo().getSite(id);
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const oldest = localDateKey(new Date(site.installed), site.timezone);
  const newest = localDateKey(new Date(Date.now() - 86400_000), site.timezone); // yesterday, site-local
  await new RollupBackfillRepo().enqueue(id, oldest, newest);

  return NextResponse.json({ success: true });
}
