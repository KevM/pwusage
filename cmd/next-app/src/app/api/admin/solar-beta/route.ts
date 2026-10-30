import { NextResponse } from 'next/server';
import { isUserAdmin } from '@/lib/auth-checks';
import { SolarBetaAdminRepo } from '@/lib/solar-beta-admin-repo';
import { SolarLayoutRepo } from '@/lib/solar-layout-repo';

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

/** GET: sites owned by solar forecast beta users, with location and latest detection. */
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

/** PUT { siteId, latitude, longitude }: seed a beta site's location so detection can run. */
export async function PUT(request: Request) {
    if (!(await isUserAdmin())) return forbidden();
    const body = await readJson(request);
    const siteId = nonEmpty(body?.siteId);
    const { latitude, longitude } = body ?? {};
    if (!siteId) return badRequest('siteId is required');
    if (typeof latitude !== 'number' || typeof longitude !== 'number'
        || !Number.isFinite(latitude) || !Number.isFinite(longitude)
        || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return badRequest('latitude and longitude must be numbers within range');
    }
    try {
        if (!(await new SolarBetaAdminRepo().siteOwnerHasBeta(siteId))) {
            return NextResponse.json({ error: 'Site owner is not in the solar forecast beta' }, { status: 409 });
        }
        await new SolarLayoutRepo().setLocation(siteId, latitude, longitude);
        return noContent();
    } catch (error) {
        console.error('[admin-solar-beta] location failed:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
