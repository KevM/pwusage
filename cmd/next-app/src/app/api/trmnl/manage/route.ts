
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

    return NextResponse.json({
        site_id: installation.site_id,
        plugin_setting_id: installation.plugin_setting_id
    });
}

import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const TRMNL_JWKS_URI = 'https://usetrmnl.com/.well-known/jwks.json';

const client = jwksClient({
    jwksUri: TRMNL_JWKS_URI,
    cache: true,
    rateLimit: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getKey(header: any, callback: any) {
    client.getSigningKey(header.kid, function (err: Error | null, key: { getPublicKey: () => string } | undefined) {
        if (err) {
            callback(err, null);
            return;
        }
        const signingKey = key?.getPublicKey();
        callback(null, signingKey);
    });
}

function verifyTrmnlToken(token: string, expectedUuid: string): Promise<void> {
    return new Promise((resolve, reject) => {
        jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
            if (err) {
                return reject(err);
            }
            const payload = decoded as jwt.JwtPayload;
            if (payload.sub !== expectedUuid) {
                return reject(new Error('Token subject does not match UUID'));
            }
            resolve();
        });
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
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const teslaClient = new TeslaClient({ accessToken: token, refreshToken });
        const repo = new EnergyRepo();
        const siteService = new SiteService({ teslaClient: teslaClient, energyRepo: repo, siteAuthToken });

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
        if (refreshToken && site_id) {
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
