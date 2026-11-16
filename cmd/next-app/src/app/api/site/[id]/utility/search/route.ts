import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { IoDeadlineError, withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { UrdbUnavailableError, utilityNames } from '@/lib/urdb/client';
import { searchUtilities } from '@/lib/urdb/utility-lookup';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/utility/search', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
    const query = req.nextUrl.searchParams.get('q')?.trim() ?? '';
    if (query.length < 2 || query.length > 64) return json({ error: 'Enter 2 to 64 characters.' }, 400);
    try {
      const names = await withIoDeadline(30_000, () => utilityNames());
      return json({ utilities: searchUtilities(query, names) });
    } catch (error) {
      if (error instanceof UrdbUnavailableError || error instanceof IoDeadlineError) return json({ error: 'Utility rates are unavailable right now.' }, 503);
      return json({ error: 'Could not search utilities.', ...errorFields(error) }, 500);
    }
  })(req);
}
