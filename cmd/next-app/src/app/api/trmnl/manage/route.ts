import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { db } from '@/lib/db';
import { cookies } from 'next/headers';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const uuid = searchParams.get('uuid');

    if (!uuid) {
        return NextResponse.json({ error: 'Missing UUID' }, { status: 400 });
    }

    const service = new TrmnlService();
    const installation = service.getInstallationByUuid(uuid);

    if (!installation) {
        return NextResponse.json({ error: 'Installation not found' }, { status: 404 });
    }

    return NextResponse.json({ site_id: installation.site_id });
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { uuid, site_id } = body;

        if (!uuid || !site_id) {
            return NextResponse.json({ error: 'Missing uuid or site_id' }, { status: 400 });
        }

        // We need to update the site_id for this installation.
        // TrmnlService doesn't have a method for just updating site_id by uuid.
        // Let's add it or do it directly here.
        // Direct DB call for simplicity since we are in API route.

        const cookieStore = await cookies();

        const refreshToken = cookieStore.get('refresh_token')?.value;
        const service = new TrmnlService();

        // Update site ID
        const updateResult = db.prepare('UPDATE TrmnlInstallation SET site_id = ? WHERE uuid = ?').run(site_id, uuid);

        if (updateResult.changes === 0) {
            // Fallback: If UUID matches nothing, try to match by access_token from cookie (Self-healing)
            const accessToken = cookieStore.get('access_token')?.value;
            if (accessToken) {
                console.log(`[TrmnlManage] UUID ${uuid} not found. Attempting to Attach UUID to existing installation via Access Token.`);
                const healResult = db.prepare('UPDATE TrmnlInstallation SET uuid = ?, site_id = ? WHERE access_token = ?').run(uuid, site_id, accessToken);
                if (healResult.changes > 0) {
                    console.log(`[TrmnlManage] Successfully healed installation record for uuid ${uuid}`);
                }
            }
        }

        // Update refresh token if available
        if (refreshToken) {
            await service.updateRefreshToken(uuid, refreshToken);
            // Also update Site table (Source of Truth)
            if (site_id) { // Using site_id from request body
                const repo = new EnergyRepo();
                // We need access token too?
                // The cookie might have it.
                const accessToken = cookieStore.get('access_token')?.value; // Accessing cookieStore directly
                if (accessToken) {
                    await repo.updateSiteTokens(site_id, accessToken, refreshToken);
                }
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Manage error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
