import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import { commitTeslaSync } from '@/lib/tesla-tariff-sync-service';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

function fingerprintFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const fingerprint = (body as { fingerprint?: unknown }).fingerprint;
  return typeof fingerprint === 'string' && fingerprint.length > 0 ? fingerprint : null;
}

export function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/tesla-sync', async () => {
    if (isCrossOriginRequest(req)) {
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    }
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid request body.' }, 400);
    }
    const fingerprint = fingerprintFrom(body);
    if (fingerprint === null) {
      return json({ error: 'Invalid request body.' }, 400);
    }
    try {
      const result = await withIoDeadline(50_000, () => commitTeslaSync(siteId, user.id, fingerprint));
      return json(result, 200);
    } catch (error) {
      return json({ error: 'Could not sync to Tesla.', ...errorFields(error) }, 500);
    }
  })(req);
}
