import { NextResponse } from 'next/server';
import { authenticateGrantToken } from '@/lib/oauth/oauth-repo';
import { INTEGRATION_RESOURCE } from '@/lib/oauth/types';
import { readCurrentBilling } from '@/lib/current-billing-service';
import { errorFields, logEvent, observeRoute, setLogContext } from '@/lib/observability';
import { computeJsonETag, ifNoneMatchMatches } from '@/lib/tariff-etag';
import { withRequestContext } from '@/lib/request-context';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PRIVATE_RESPONSE = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };

function revisionTag(revision: string, energyDataThrough?: Date | null): string {
    return `W/"bill-v1-compact-${revision}-${energyDataThrough?.getTime() ?? 'unknown'}"`;
}

function billingHeaders(etag: string) {
    return { 'Cache-Control': 'private, no-cache', Vary: 'Authorization', ETag: etag };
}

async function handleGET(request: Request) {
    return withRequestContext(async () => {
        try {
            const grant = await authenticateGrantToken(
                request.headers.get('Authorization'),
                { kind: 'integration', resource: INTEGRATION_RESOURCE },
            );
            // An integration token is bound to exactly one home; anything else fails closed.
            const siteId = grant?.authorizedSiteIds.length === 1 ? grant.authorizedSiteIds[0] : undefined;
            if (!grant || !siteId) {
                return NextResponse.json({ error: 'Unauthorized' }, {
                    status: 401,
                    headers: { ...PRIVATE_RESPONSE, 'WWW-Authenticate': 'Bearer' },
                });
            }

            setLogContext({ siteId, grantId: grant.grantId });
            if (!grant.scopes.includes('billing:read')) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: PRIVATE_RESPONSE });
            }
            const result = await readCurrentBilling(siteId, {
                refreshStale: true,
                includeLoadTimingTimeline: false,
                acceptRevision: (revision, latest) => ifNoneMatchMatches(request, revisionTag(revision, latest)),
            });
            if (result.status === 'not-found') {
                return NextResponse.json({ error: 'Site not found' }, { status: 404, headers: PRIVATE_RESPONSE });
            }
            if (result.status === 'unchanged') {
                return new NextResponse(null, {
                    status: 304,
                    headers: billingHeaders(revisionTag(result.revision, result.energyDataThrough)),
                });
            }
            const etag = result.revision
                ? revisionTag(result.revision, result.energyDataThrough)
                : `W/${computeJsonETag({
                    ...result.summary,
                    sources: { energyDataThrough: result.summary.sources.energyDataThrough },
                }).etag}`;
            const headers = billingHeaders(etag);
            if (ifNoneMatchMatches(request, etag)) {
                return new NextResponse(null, { status: 304, headers });
            }
            return NextResponse.json(result.summary, { headers });
        } catch (error) {
            logEvent('error', 'integration.billing.failed', errorFields(error));
            return NextResponse.json({ error: 'Failed to fetch bill summary' }, { status: 500, headers: PRIVATE_RESPONSE });
        }
    });
}

export const GET = observeRoute('/api/integrations/v1/billing', handleGET);
