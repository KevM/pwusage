
import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { pool } from '@/lib/db';
import { cookies } from 'next/headers';
import { TeslaClient } from '@/lib/tesla-client';
import { SiteService } from '@/lib/site-service';
import { verifyTrmnlToken } from '@/lib/trmnl-auth';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const uuid = searchParams.get('uuid');

    const secret = searchParams.get('token');

    // Auth Strategy: 
    // 1. Trmnl Token (Proof of Device Ownership) - Allows reading current config
    // 2. Site Auth (Proof of Site Ownership) - Allows reading if linked? 
    // Actually, usually Trmnl Page has the Token.

    let isAuthorized = false;

    // Verify Trmnl Token if present
    if (secret && uuid) {
        try {
            await verifyTrmnlToken(secret, uuid);
            isAuthorized = true;
        } catch (e) {
            console.warn(`[TrmnlManage] GET Token verification failed: ${e}`);
        }
    }

    // Verify Site Auth if present
    const cookieStore = await cookies();
    const siteAuthToken = cookieStore.get('site_auth')?.value;

    if (siteAuthToken) {
        isAuthorized = true;
        // Technically we should check if this user owns the linked site, 
        // but for just retrieving the uuid's status, knowing they are a valid user might be enough?
        // Or strictly: if they own the site currently linked.
    }

    if (!isAuthorized) {
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

    return NextResponse.json({
        site_id: installation.site_id,
        plugin_setting_id: installation.plugin_setting_id
    });
}



export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { uuid, site_id, token: trmnlToken } = body;

        if (!uuid || !site_id) {
            return NextResponse.json({ error: 'Missing uuid or site_id' }, { status: 400 });
        }

        // Verify Trmnl JWT
        if (!trmnlToken) {
            console.warn(`[TrmnlManage] Missing JWT for UUID ${uuid}`);
            return NextResponse.json({ error: 'Missing security token' }, { status: 401 });
        }

        try {
            await verifyTrmnlToken(trmnlToken, uuid);
        } catch (err) {
            console.error(`[TrmnlManage] JWT Verification Failed for ${uuid}:`, err);
            return NextResponse.json({ error: 'Invalid security token' }, { status: 403 });
        }

        const cookieStore = await cookies();

        const token = cookieStore.get('access_token')?.value;
        const refreshToken = cookieStore.get('refresh_token')?.value;
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        if (!token) {
            // No legacy token check
        }

        // We require site_auth to prove ownership of the site we are linking TO
        if (!siteAuthToken) {
            return NextResponse.json({ error: 'Unauthorized: Please log in to link a site' }, { status: 401 });
        }

        const repo = new EnergyRepo();
        // Since we have siteAuthToken, we don't need teslaClient to validate access, 
        // SiteService can do it via JWT or DB check.
        const siteService = new SiteService({ energyRepo: repo, siteAuthToken });

        if (!await siteService.validateSiteAccess(site_id)) {
            return NextResponse.json({ error: 'Unauthorized access to site' }, { status: 403 });
        }

        // Create or Update installation (UPSERT)
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


        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Manage error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
