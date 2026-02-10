
import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { pool } from '@/lib/db';
import { cookies } from 'next/headers';
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

        // Authentication Strategy:
        // 1. Trmnl JWT (Proof of Device Ownership) - Strongest
        // 2. Site Auth (Proof of User/Site Ownership) - Contingency for Re-auth/loss of token

        let isDeviceAuthorized = false;
        let isTargetSiteAuthorized = false;

        // 1. Verify Trmnl JWT if present
        if (trmnlToken) {
            try {
                await verifyTrmnlToken(trmnlToken, uuid);
                isDeviceAuthorized = true;
            } catch (err) {
                console.warn(`[TrmnlManage] JWT Verification Failed for ${uuid}:`, err);
                // Don't return error yet, try method 2
            }
        }

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;
        const repo = new EnergyRepo();

        // Initialize Tesla Client if we can resolve an access token from the DB for the current user
        let accessToken: string | undefined;

        if (siteAuthToken) {
            const { verifySiteToken } = await import('@/lib/auth-jwt');
            const { getUserTokens } = await import('@/lib/energy-repo');

            const decoded = verifySiteToken(siteAuthToken);
            if (decoded && decoded.sub) {
                const userTokens = await getUserTokens(decoded.sub);
                if (userTokens) {
                    accessToken = userTokens.access_token;
                }
            }
        }

        let teslaClient;
        if (accessToken) {
            const { TeslaClient } = await import('@/lib/tesla-client');
            teslaClient = new TeslaClient({ accessToken });
        }

        const siteService = new SiteService({
            energyRepo: repo,
            siteAuthToken,
            teslaClient
        });

        // 2. Fallback to Site Auth (Only for EXISTING installations)
        // Check if we have EITHER site auth (JWT) or access token (API)
        if (!isDeviceAuthorized && (siteAuthToken || accessToken)) {
            console.log(`[TrmnlManage] Attempting Site Auth fallback for UUID: ${uuid}`);

            // Check if this UUID is already linked to a site this user owns
            const tService = new TrmnlService();
            const existing = await tService.getInstallationByUuid(uuid);

            if (existing && existing.site_id) {
                console.log(`[TrmnlManage] Found existing installation for ${uuid} linked to site ${existing.site_id}`);

                // Verify user owns the CURRENTLY linked site
                // This proves they are authorized to manage the device already
                const hasAccessToOldSite = await siteService.validateSiteAccess(existing.site_id);
                if (hasAccessToOldSite) {
                    console.log(`[TrmnlManage] Authorized via Site Ownership (Re-auth) for ${uuid}`);
                    isDeviceAuthorized = true;

                    // Optimization: If the target site is the same as the one we just validated, 
                    // we don't need to validate it again.
                    if (existing.site_id === site_id) {
                        isTargetSiteAuthorized = true;
                        console.log(`[TrmnlManage] Target site ${site_id} matches existing authorized site. Skipping redundant check.`);
                    }
                } else {
                    console.warn(`[TrmnlManage] User tried to manage ${uuid} but does not own current site ${existing.site_id}`);
                }
            } else {
                console.warn(`[TrmnlManage] Cannot use Site Auth for NEW/Unlinked installation ${uuid}. Trmnl Token required. Existing: ${JSON.stringify(existing)}`);
            }
        } else if (!isDeviceAuthorized) {
            console.warn(`[TrmnlManage] Unauthorized. Token present: ${!!trmnlToken}, SiteAuth present: ${!!siteAuthToken}, AccessToken present: ${!!accessToken}`);
        }

        if (!isDeviceAuthorized) {
            return NextResponse.json({ error: 'Unauthorized: Missing or invalid security token' }, { status: 401 });
        }

        // Validate target site access (always required if changing link)
        // If we already validated it during the re-auth flow, skip this check.
        if (!isTargetSiteAuthorized) {
            if (!await siteService.validateSiteAccess(site_id)) {
                return NextResponse.json({ error: 'Unauthorized access to target site' }, { status: 403 });
            }
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
