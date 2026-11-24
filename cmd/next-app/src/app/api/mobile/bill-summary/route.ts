import { NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { readCurrentBilling } from '@/lib/current-billing-service';
import { withRequestContext } from '@/lib/request-context';

export const dynamic = 'force-dynamic';

const PRIVATE_RESPONSE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
    return withRequestContext(async () => {
        try {
            const params = new URL(request.url).searchParams;
            const siteId = params.get('siteId');
            const includeOutlook = params.get('outlook') === '1';
            const knownRevision = includeOutlook ? params.get('knownRevision') : null;
            if (!siteId) return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
            if (!(await verifySiteAccess(siteId))) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            const result = await readCurrentBilling(siteId, {
                includeOutlook,
                acceptRevision: knownRevision !== null ? revision => revision === knownRevision : undefined,
            });
            if (result.status === 'not-found') return NextResponse.json({ error: 'Site not found' }, { status: 404 });
            if (result.status === 'unchanged') return new NextResponse(null, { status: 304, headers: PRIVATE_RESPONSE });
            return NextResponse.json(result.summary, { headers: PRIVATE_RESPONSE });
        } catch (error) {
            console.error('[mobile-bill-summary] request failed:', error);
            return NextResponse.json({ error: 'Failed to fetch mobile bill summary' }, { status: 500 });
        }
    });
}
