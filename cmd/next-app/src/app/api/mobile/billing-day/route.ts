import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { parseBillingDay } from '@/lib/billing-cycle';
import { SiteRepo } from '@/lib/site-repo';
import { withRequestContext } from '@/lib/request-context';

export const dynamic = 'force-dynamic';

const PRIVATE_RESPONSE = { 'Cache-Control': 'private, no-store' };

function jsonError(error: string, status: number): NextResponse {
    return NextResponse.json({ error }, { status, headers: PRIVATE_RESPONSE });
}

/**
 * Sets a site's billing day and marks it confirmed. Posting the day a site
 * already has is valid: it is how a person confirms the default. The write is
 * authenticated by the site_auth cookie, so browser cross-origin requests are
 * refused; native requests send no Origin header and pass.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
    return withRequestContext(async () => {
        const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') return jsonError('Content-Type must be application/json', 415);

        const origin = request.headers.get('origin');
        if (origin) {
            let originUrl: URL;
            try {
                originUrl = new URL(origin);
            } catch {
                return jsonError('Cross-origin requests are not allowed', 403);
            }
            if (originUrl.origin !== request.nextUrl.origin) {
                return jsonError('Cross-origin requests are not allowed', 403);
            }
        }
        if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
            return jsonError('Cross-origin requests are not allowed', 403);
        }

        let body: { siteId?: unknown; day?: unknown };
        try {
            body = await request.json();
        } catch {
            return jsonError('Invalid JSON body', 400);
        }
        if (!body || typeof body !== 'object') return jsonError('Invalid JSON body', 400);

        const siteId = typeof body.siteId === 'string' ? body.siteId : '';
        if (!siteId) return jsonError('Missing siteId', 400);
        // A day sent as a string would make a client bug look like success; native clients send numbers.
        const day = typeof body.day === 'number' ? parseBillingDay(body.day) : null;
        if (day === null) return jsonError('Invalid day', 400);

        if (!(await verifySiteAccess(siteId))) return jsonError('Unauthorized', 401);

        await new SiteRepo().updateSiteBillingDay(siteId, day);
        return NextResponse.json({ billingDay: day, billingDayConfirmed: true }, { headers: PRIVATE_RESPONSE });
    });
}
