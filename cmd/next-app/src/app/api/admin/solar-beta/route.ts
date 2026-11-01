import { NextResponse } from 'next/server';
import { isUserAdmin } from '@/lib/auth-checks';
import { SolarBetaAdminRepo } from '@/lib/solar-beta-admin-repo';

export const dynamic = 'force-dynamic';

const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 });
const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });
const noContent = () => new NextResponse(null, { status: 204 });

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
    try {
        const body = await request.json();
        return body && typeof body === 'object' ? body as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** GET: sites owned by solar forecast beta users. */
export async function GET() {
    if (!(await isUserAdmin())) return forbidden();
    try {
        return NextResponse.json({ sites: await new SolarBetaAdminRepo().listBetaSites() });
    } catch (error) {
        console.error('[admin-solar-beta] list failed:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

/** POST { siteId | email, enabled }: grant or revoke the beta for the owning user. */
export async function POST(request: Request) {
    if (!(await isUserAdmin())) return forbidden();
    const body = await readJson(request);
    const siteId = nonEmpty(body?.siteId);
    const email = siteId ? undefined : nonEmpty(body?.email)?.toLowerCase();
    if (!siteId && !email) return badRequest('siteId or email is required');
    if (typeof body?.enabled !== 'boolean') return badRequest('enabled must be true or false');
    try {
        const repo = new SolarBetaAdminRepo();
        const userId = await repo.findUserId({ siteId, email });
        if (!userId) return NextResponse.json({ error: 'No matching user' }, { status: 404 });
        await repo.setBeta(userId, body.enabled);
        return noContent();
    } catch (error) {
        console.error('[admin-solar-beta] update failed:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

