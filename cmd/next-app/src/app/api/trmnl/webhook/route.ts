import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import {
    extractTrmnlComponentScreens,
    extractTrmnlCarouselIndex,
    mergeTrmnlComponentScreensIntoInstallationJson
} from '@/lib/trmnl-component-config';
import { verifyTrmnlToken, VerifiedTrmnlTokenPayload, safeTimingSafeEqual } from '@/lib/trmnl-auth';
import { SiteRepo } from '@/lib/site-repo';
import { UserRepo } from '@/lib/user-repo';

function coercePositiveInt(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return null;
}

async function syncUserEmail(siteId: string, email: string) {
    const siteRepo = new SiteRepo();
    const userRepo = new UserRepo();
    const site = await siteRepo.getSite(siteId);
    if (site && site.user_id) {
        const currentEmail = await userRepo.getUserEmail(site.user_id);
        if (!currentEmail) {
            await userRepo.updateUserEmail(site.user_id, email);
            console.log(`[TrmnlWebhook] Updated user ${site.user_id} with email from Trmnl: ${email}`);
        }
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { user } = body;

        if (!user || !user.uuid) {
            console.error('[TrmnlWebhook] Invalid payload:', JSON.stringify(body));
            return NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 });
        }

        // --- SIGNATURE VERIFICATION ---
        const authHeader = request.headers.get('Authorization');
        const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

        if (!token) {
            console.warn(`[TrmnlWebhook] Rejecting unsigned webhook for ${user.uuid}`);
            return NextResponse.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
        }

        const tokenParts = token.split('.');
        const isJwtFormat = tokenParts.length === 3;

        let payload: VerifiedTrmnlTokenPayload;
        let matchedInstallation: import('@/lib/db').TrmnlInstallation | undefined;

        if (isJwtFormat) {
            // Production: JWT-signed webhook
            try {
                payload = await verifyTrmnlToken(token, user.uuid);
            } catch (err) {
                console.error(`[TrmnlWebhook] JWT Verification Failed for ${user.uuid}:`, err);
                return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
            }
        } else {
            // Opaque token: We MUST verify it against a stored access_token in the DB.
            const service = new TrmnlService();

            // 1. Check existing installation by uuid
            const existing = await service.getInstallationByUuid(user.uuid, { includeTokens: true });
            if (existing && existing.access_token && safeTimingSafeEqual(token, existing.access_token)) {
                matchedInstallation = existing;
            }

            // 2. Check pending by plugin_setting_id
            if (!matchedInstallation && user.plugin_setting_id) {
                const bodyPluginId = coercePositiveInt(user.plugin_setting_id);
                if (bodyPluginId !== null) {
                    const pending = await service.getInstallationByPendingPluginId(bodyPluginId);
                    if (pending && pending.access_token && safeTimingSafeEqual(token, pending.access_token)) {
                        matchedInstallation = pending;
                    }
                }
            }

            // 3. Check latest loose pending installation (within 15 min window)
            if (!matchedInstallation) {
                const loosePending = await service.getLatestLoosePendingInstallation();
                if (loosePending && loosePending.access_token && safeTimingSafeEqual(token, loosePending.access_token)) {
                    // Check if it's within the 15-minute window
                    const ageMs = new Date().getTime() - new Date(loosePending.created_at).getTime();
                    if (ageMs < 15 * 60 * 1000) {
                        matchedInstallation = loosePending;
                    }
                }
            }

            if (!matchedInstallation) {
                console.warn(`[TrmnlWebhook] Rejecting opaque token for ${user.uuid}: No matching installation or token mismatch`);
                return NextResponse.json({ error: 'Unauthorized: Invalid opaque token' }, { status: 401 });
            }

            // Opaque token: Accept as valid and extract user info from webhook body
            // (used by dev/preview plugins that don't support JWT signing)
            payload = {
                sub: user.uuid,
                plugin_setting_id: user.plugin_setting_id,
                user: user
            } as VerifiedTrmnlTokenPayload;
        }

        // Verify that the token corresponds to the requested plugin_setting_id
        const tokenPluginId = coercePositiveInt(payload.plugin_setting_id)
            ?? coercePositiveInt(payload.user?.plugin_setting_id);
        const bodyPluginId = coercePositiveInt(user.plugin_setting_id);

        if (!tokenPluginId) {
            console.warn(`[TrmnlWebhook] Rejecting webhook for ${user.uuid}: Token missing plugin_setting_id`);
            return NextResponse.json({ error: 'Forbidden: Token missing plugin_setting_id' }, { status: 403 });
        }

        if (bodyPluginId !== null && tokenPluginId !== bodyPluginId) {
            console.warn(`[TrmnlWebhook] Plugin ID mismatch for ${user.uuid}. Token: ${tokenPluginId}, Body: ${bodyPluginId}`);
            return NextResponse.json({ error: 'Forbidden: Plugin ID mismatch' }, { status: 403 });
        }

        console.log(`[TrmnlWebhook] Received verified webhook for UUID: ${user.uuid}, Plugin ID: ${tokenPluginId}`);

        const service = new TrmnlService();

        // We might not have the site_id here if it's the first time we see this UUID via webhook.
        // However, the installation flow (screen) usually runs first and sets the site_id.
        // If we don't have an installation yet, we can create one with a placeholder or null site_id?
        // But createInstallation requires a siteId. 
        // Strategy: 
        // 1. Check if installation exists. 
        // 2. If yes, update it with new details (plugin_setting_id, json).
        // 3. If no, we can't create it fully without a site_id. We might just log it or fail.
        //    However, usually the user goes through the Install Flow -> Trmnl Connect -> Setup API -> Webhook.
        //    So the installation should exist.

        // Reuse the already-fetched installation if it matches user.uuid
        const existing = (matchedInstallation && matchedInstallation.uuid === user.uuid)
            ? matchedInstallation
            : await service.getInstallationByUuid(user.uuid);

        if (existing) {
            const screens = extractTrmnlComponentScreens(existing.json);
            const carouselIndex = extractTrmnlCarouselIndex(existing.json, screens.length);
            const mergedInstallationJson = mergeTrmnlComponentScreensIntoInstallationJson(
                user,
                screens,
                carouselIndex
            );
            // Update with new details
            await service.createInstallation(
                existing.site_id,
                user.uuid,
                tokenPluginId,
                mergedInstallationJson
            );

            // Update user email if not present
            if (user.email && existing.site_id) {
                await syncUserEmail(existing.site_id, user.email);
            }
        } else {
            // 1. Check for Pending installation by plugin_setting_id (Strong Link)
            // Use tokenPluginId (trusted) instead of body value
            let pending = await service.getInstallationByPendingPluginId(tokenPluginId);

            // 2. Fallback: Check for "Loose" Pending installation (NULL UUID, NULL PluginID)
            // We take the MOST RECENT one, but only if it was created within the last 15 minutes to reduce race conditions.
            if (!pending) {
                const loosePending = await service.getLatestLoosePendingInstallation();
                if (loosePending && (new Date().getTime() - new Date(loosePending.created_at).getTime()) < 15 * 60 * 1000) {
                    pending = loosePending;
                } else if (loosePending) {
                    console.warn(`[TrmnlWebhook] Found a loose pending installation but it is too old to safely claim.`);
                }
            }

            if (pending) {
                const screens = extractTrmnlComponentScreens(pending.json);
                const carouselIndex = extractTrmnlCarouselIndex(pending.json, screens.length);
                const mergedInstallationJson = mergeTrmnlComponentScreensIntoInstallationJson(
                    user,
                    screens,
                    carouselIndex
                );
                console.log(`[TrmnlWebhook] Claiming pending installation (ID: ${pending.id}) for plugin ${tokenPluginId} / UUID ${user.uuid}`);
                // If it was a "loose" pending record, it might not have the plugin_setting_id set either.
                // We update it with BOTH.
                // We pass the pending record's ID to ensure we update the correct row if we add a method for ID-based update, 
                // OR we rely on claimPending... but claimPendingPluginId queries by plugin_setting_id.
                // We need a new method to claim by Row ID.
                await service.claimPendingInstallationById(
                    pending.id,
                    user.uuid,
                    tokenPluginId,
                    mergedInstallationJson
                );

                // Update user email if not present
                if (user.email && pending.site_id) {
                    await syncUserEmail(pending.site_id, user.email);
                }
            } else {
                console.warn(`[TrmnlWebhook] Received success webhook for unknown UUID: ${user.uuid} and unknown Plugin ID: ${tokenPluginId}. details ignored.`);
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
