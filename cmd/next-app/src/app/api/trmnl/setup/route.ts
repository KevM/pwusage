import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { getAuthorizedSiteIds, getCurrentUser, isUserAdmin, verifySiteAccess } from '@/lib/auth-checks';
import { SiteRepo } from '@/lib/site-repo';
import { withRequestContext } from '@/lib/request-context';
import {
    buildDefaultTrmnlComponentScreens,
    coercePositiveInt,
    mergeTrmnlComponentScreensIntoInstallationJson
} from '@/lib/trmnl-component-config';

export async function POST(request: Request) {
    return withRequestContext(async () => {
        try {
        const body = await request.json();
        const { code, site_id, uuid } = body;
        const pluginSettingId = coercePositiveInt(body.plugin_setting_id);

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
        const installer = await getCurrentUser();
        if (!installer) return NextResponse.json({ error: 'Sign in to connect a TRMNL device' }, { status: 401 });

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
        const bodyUuid = typeof uuid === 'string' && uuid.trim() ? uuid.trim() : null;

        // Resolve device UUID exclusively from provider credentials; treat body.uuid as a hint only.
        let providerUuid: string | null = null;

        // 1. Check if UUID is in the OAuth response directly (some providers do this)
        if (tokenData.user_uuid) providerUuid = tokenData.user_uuid;
        else if (tokenData.uuid) providerUuid = tokenData.uuid;
        else if (tokenData.user && tokenData.user.uuid) providerUuid = tokenData.user.uuid;

        if (providerUuid) console.log(`[TrmnlSetup] Found UUID in OAuth response: ${providerUuid}`);

        // 2. Try to extract UUID from JWT
        if (!providerUuid) {
            try {
                const parts = accessToken.split('.');
                if (parts.length === 3) {
                    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
                    if (payload.user_uuid) {
                        providerUuid = payload.user_uuid;
                        console.log(`[TrmnlSetup] Extracted UUID from JWT: ${providerUuid}`);
                    }
                }
            } catch {
                console.log('[TrmnlSetup] Access token is not a simple JWT');
            }
        }

        // 3. Fallback to API fetch, or pending installation if provider UUID cannot be resolved
        if (!providerUuid) {
            try {
                const me = await service.fetchMe(accessToken);
                providerUuid = me.uuid || null;
                if (providerUuid) console.log(`[TrmnlSetup] Fetched UUID from API: ${providerUuid}`);
            } catch (err) {
                console.error('[TrmnlSetup] Failed to fetch UUID from API:', err);
            }
        }

        if (!providerUuid) {
            // If we have a plugin_setting_id (from frontend), we use it.
            if (pluginSettingId !== null) {
                console.log(`[TrmnlSetup] Saving 'Pending' installation linked to Plugin ID: ${pluginSettingId}`);
                await service.createInstallation(
                    site_id,
                    null,
                    pluginSettingId,
                    defaultInstallationJson,
                    accessToken,
                    installer.id
                );
                return NextResponse.json({ success: true, status: 'pending_webhook' });
            }

            // FALLBACK: Loose Linking
            // We save a "Pending" record with NO IDs, just the Site ID and Token.
            console.warn('[TrmnlSetup] Unable to identify user/plugin. Saving generic Pending record.');
            await service.createInstallation(site_id, null, null, defaultInstallationJson, accessToken, installer.id);
            return NextResponse.json({ success: true, status: 'pending_loose' });
        }

        if (bodyUuid && bodyUuid !== providerUuid) {
            console.warn(`[TrmnlSetup] Rejecting setup: client UUID hint (${bodyUuid}) does not match provider UUID (${providerUuid})`);
            return NextResponse.json({ error: 'Device UUID mismatch' }, { status: 403 });
        }

        const existing = await service.getInstallationByUuid(providerUuid);
        const admin = await isUserAdmin();
        if (existing && existing.site_id !== site_id && !admin) {
            const ownsExistingSite = await verifySiteAccess(existing.site_id);
            if (!ownsExistingSite) {
                console.warn(`[TrmnlSetup] Rejecting reassignment of device ${providerUuid} from site ${existing.site_id} to ${site_id}`);
                return NextResponse.json({ error: 'Unauthorized: Device is already linked to another site' }, { status: 403 });
            }
        }

        const allowedExistingSiteIds = admin ? null : await getAuthorizedSiteIds();

        // Create/Update installation with Site ID and verified provider UUID,
        // enforcing existing-site ownership atomically at the write.
        const savedId = await service.createInstallation(
            site_id,
            providerUuid,
            pluginSettingId,
            defaultInstallationJson,
            accessToken,
            installer.id,
            { allowedExistingSiteIds }
        );

        if (savedId === null) {
            return NextResponse.json({ error: 'Unauthorized: Device is already linked to another site' }, { status: 403 });
        }

        return NextResponse.json({ success: true });
        } catch (error) {
            console.error('Setup error:', error);
            return NextResponse.json({ error: (error as Error).message }, { status: 500 });
        }
    });
}
