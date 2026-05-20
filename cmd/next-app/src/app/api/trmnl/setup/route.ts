import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { verifySiteAccess } from '@/lib/auth-checks';
import { SiteRepo } from '@/lib/site-repo';
import { withRequestContext } from '@/lib/request-context';
import {
    buildDefaultTrmnlComponentScreens,
    mergeTrmnlComponentScreensIntoInstallationJson
} from '@/lib/trmnl-component-config';

export async function POST(request: Request) {
    return withRequestContext(async () => {
        try {
        const body = await request.json();
        const { code, site_id, uuid } = body;

        if (!code || !site_id) {
            return NextResponse.json({ error: 'Missing code or site_id' }, { status: 400 });
        }

        const clientId = process.env.TRMNL_CLIENT_ID;
        const clientSecret = process.env.TRMNL_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            return NextResponse.json({ error: 'Server misconfigured: Missing Trmnl credentials' }, { status: 500 });
        }

        if (!await verifySiteAccess(site_id)) {
            console.log(`[TrmnlSetup] Unauthorized access to site ${site_id}`);
            return NextResponse.json({ error: 'Unauthorized access to site' }, { status: 403 });
        }

        const repo = new SiteRepo();
        const site = await repo.getSite(site_id);
        if (!site) {
            console.warn(`[TrmnlSetup] Site ${site_id} not found during setup`);
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }

        // Save installation
        const service = new TrmnlService();
        const defaultInstallationJson = mergeTrmnlComponentScreensIntoInstallationJson(
            null,
            buildDefaultTrmnlComponentScreens()
        );

        const tokenData = await service.exchangeCodeForToken(code, clientId, clientSecret);
        const accessToken = tokenData.access_token;

        // Fetch the UUID from Trmnl using the new token
        let deviceUuid = uuid;

        // 1. Check if UUID is in the OAuth response directly (some providers do this)
        if (!deviceUuid) {
            if (tokenData.user_uuid) deviceUuid = tokenData.user_uuid;
            else if (tokenData.uuid) deviceUuid = tokenData.uuid;
            else if (tokenData.user && tokenData.user.uuid) deviceUuid = tokenData.user.uuid;

            if (deviceUuid) console.log(`[TrmnlSetup] Found UUID in OAuth response: ${deviceUuid}`);
        }

        // 2. Try to extract UUID from JWT first
        if (!deviceUuid) {
            try {
                const parts = accessToken.split('.');
                if (parts.length === 3) {
                    const payload = JSON.parse(atob(parts[1]));
                    if (payload.user_uuid) {
                        deviceUuid = payload.user_uuid;
                        console.log(`[TrmnlSetup] Extracted UUID from JWT: ${deviceUuid}`);
                    }
                }
            } catch {
                console.log('[TrmnlSetup] Access token is not a simple JWT');
            }
        }

        // 3. Fallback to API fetch, but include debug info in error if it fails
        if (!deviceUuid) {
            try {
                const me = await service.fetchMe(accessToken);
                deviceUuid = me.uuid;
                console.log(`[TrmnlSetup] Fetched UUID from API: ${deviceUuid}`);
            } catch (err) {
                console.error('[TrmnlSetup] Failed to fetch UUID from API:', err);

                // If we have a plugin_setting_id (from frontend), we use it.
                if (body.plugin_setting_id) {
                    console.log(`[TrmnlSetup] Saving 'Pending' installation linked to Plugin ID: ${body.plugin_setting_id}`);
                    await service.createInstallation(
                        site_id,
                        null,
                        parseInt(body.plugin_setting_id),
                        defaultInstallationJson,
                        accessToken
                    );
                    return NextResponse.json({ success: true, status: 'pending_webhook' });
                }

                // FALLBACK: Loose Linking
                // We save a "Pending" record with NO IDs, just the Site ID and Token.
                // The next Webhook to arrive (which will be for this new plugin) will claim it.
                // This assumes single-user / sequential installation flow, which is true for this personal app.
                console.warn('[TrmnlSetup] Unable to identify user/plugin. Saving generic Pending record for Webhook to claim.');
                await service.createInstallation(site_id, null, null, defaultInstallationJson, accessToken);
                return NextResponse.json({ success: true, status: 'pending_loose' });

                /*
                // CRITICAL DEBUG information is no longer needed to throw, we proceed with Loose Linking.
                // const keys = Object.keys(tokenData).join(', ');
                // throw new Error(`Failed to identify user...`);
                */
            }
        }

        // Create/Update installation with Site ID and UUID
        // We store the Trmnl Access Token here for verification, NOT in the Site table.
        // The Site table stores Tesla Tokens.
        await service.createInstallation(
            site_id,
            deviceUuid,
            body.plugin_setting_id ? parseInt(body.plugin_setting_id) : null,
            defaultInstallationJson,
            accessToken
        );

        return NextResponse.json({ success: true });
        } catch (error) {
            console.error('Setup error:', error);
            return NextResponse.json({ error: (error as Error).message }, { status: 500 });
        }
    });
}
