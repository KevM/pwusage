
import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { pool } from '@/lib/db';
import { cookies } from 'next/headers';
import { TeslaClient } from '@/lib/tesla-client';
import { SiteService } from '@/lib/site-service';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const uuid = searchParams.get('uuid');

    const cookieStore = await cookies();
    const token = cookieStore.get('access_token')?.value;

    // Optional: Allow Trmnl bot to manage if identified? No, this is for user UI.
    // The device (bot) uses /api/trmnl/setup or /api/trmnl/markup?
    // /manage is strictly for the user management page.

    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!uuid) {
        return NextResponse.json({ error: 'Missing UUID' }, { status: 400 });
    }

    const service = new TrmnlService();
    const installation = await service.getInstallationByUuid(uuid);

    if (!installation) {
        return NextResponse.json({ site_id: null });
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

        const cookieStore = await cookies();

        const token = cookieStore.get('access_token')?.value;
        const refreshToken = cookieStore.get('refresh_token')?.value;
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        if (!token) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const client = new TeslaClient({ accessToken: token, refreshToken });
        const repo = new EnergyRepo();
        const siteService = new SiteService({ teslaClient: client, energyRepo: repo, siteAuthToken });

        if (!await siteService.validateSiteAccess(site_id)) {
            return NextResponse.json({ error: 'Unauthorized access to site' }, { status: 403 });
        }

        const trmnlService = new TrmnlService();

        // Create or Update installation (UPSERT)
        // We trust the user is authenticated and authorized now.

        const query = `
            INSERT INTO "TrmnlInstallation" (uuid, site_id)
            VALUES ($1, $2)
            ON CONFLICT(uuid) DO UPDATE SET 
                site_id = EXCLUDED.site_id
            RETURNING id
        `;

        const { rows } = await pool.query(query, [uuid, site_id]);

        if (rows.length === 0) {
            console.log(`[TrmnlManage] Failed to upsert installation for UUID ${uuid}.`);
            return NextResponse.json({ error: 'Failed to save installation' }, { status: 500 });
        }

        // Update refresh token in Site table (Source of Truth) if available
        if (refreshToken && site_id) {
            const repo = new EnergyRepo();
            const accessToken = cookieStore.get('access_token')?.value;
            // We use the tokens from cookie (Tesla Auth) to update the Site.
            if (accessToken) {
                await repo.updateSiteTokens(site_id, accessToken, refreshToken);
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Manage error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
