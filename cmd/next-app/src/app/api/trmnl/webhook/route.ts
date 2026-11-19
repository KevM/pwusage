import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import {
    coercePositiveInt,
    extractTrmnlComponentScreens,
    extractTrmnlCarouselIndex,
    mergeTrmnlComponentScreensIntoInstallationJson
} from '@/lib/trmnl-component-config';
import { verifyTrmnlToken, VerifiedTrmnlTokenPayload, safeTimingSafeEqual } from '@/lib/trmnl-auth';
import { UserRepo } from '@/lib/user-repo';
import type { TrmnlInstallation } from '@/lib/db';

async function syncUserEmail(installation: TrmnlInstallation, email: string) {
    const installerId = installation.installed_by_user_id;
    if (!installerId) return;
    const userRepo = new UserRepo();
    const currentEmail = await userRepo.getUserEmail(installerId);
    if (!currentEmail) {
        await userRepo.updateUserEmail(installerId, email);
        console.log(`[TrmnlWebhook] Updated installer ${installerId} with email from Trmnl`);
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
        let matchedInstallation: TrmnlInstallation | undefined;
        const service = new TrmnlService();

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
            const bodyPluginIdForLookup = coercePositiveInt(user.plugin_setting_id);

            // 1. Check existing installation by uuid
            const existingByUuid = await service.getInstallationByUuid(user.uuid, { includeTokens: true });
            if (existingByUuid) {
                if (existingByUuid.access_token && safeTimingSafeEqual(token, existingByUuid.access_token)) {
                    matchedInstallation = existingByUuid;
                } else {
                    console.warn(`[TrmnlWebhook] Rejecting opaque token for ${user.uuid}: Token mismatch on existing installation`);
                    return NextResponse.json({ error: 'Unauthorized: Invalid opaque token' }, { status: 401 });
                }
            }

            // 2. Check pending by plugin_setting_id
            if (!matchedInstallation && bodyPluginIdForLookup !== null) {
                const pending = await service.getInstallationByPendingPluginId(bodyPluginIdForLookup);
                if (pending && pending.access_token && safeTimingSafeEqual(token, pending.access_token)) {
                    matchedInstallation = pending;
                }
            }

            // 3. Check recent loose pending installations (within 15 min window) by exact token match
            if (!matchedInstallation) {
                const recentLoose = await service.getRecentLoosePendingInstallations(15 * 60 * 1000);
                const nowMs = Date.now();
                for (const candidate of recentLoose) {
                    const ageMs = nowMs - new Date(candidate.created_at).getTime();
                    if (ageMs < 15 * 60 * 1000 && candidate.access_token && safeTimingSafeEqual(token, candidate.access_token)) {
                        matchedInstallation = candidate;
                        break;
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

        if (user.plugin_setting_id !== undefined && tokenPluginId !== bodyPluginId) {
            console.warn(`[TrmnlWebhook] Plugin ID mismatch for ${user.uuid}. Token: ${tokenPluginId}, Body: ${user.plugin_setting_id}`);
            return NextResponse.json({ error: 'Forbidden: Plugin ID mismatch' }, { status: 403 });
        }

        console.log(`[TrmnlWebhook] Received verified webhook for UUID: ${user.uuid}, Plugin ID: ${tokenPluginId}`);

        const claimPendingRow = async (pendingRow: TrmnlInstallation) => {
            const screens = extractTrmnlComponentScreens(pendingRow.json);
            const carouselIndex = extractTrmnlCarouselIndex(pendingRow.json, screens.length);
            const mergedInstallationJson = mergeTrmnlComponentScreensIntoInstallationJson(
                user,
                screens,
                carouselIndex
            );
            console.log(`[TrmnlWebhook] Claiming pending installation (ID: ${pendingRow.id}) for plugin ${tokenPluginId} / UUID ${user.uuid}`);
            const claimed = await service.claimPendingInstallationById(
                pendingRow.id,
                user.uuid,
                tokenPluginId,
                mergedInstallationJson
            );

            if (!claimed) {
                const current = await service.getInstallationById(pendingRow.id);
                if (current && current.uuid === user.uuid && (current.plugin_setting_id === null || current.plugin_setting_id === tokenPluginId)) {
                    return NextResponse.json({ success: true });
                }
                return NextResponse.json({ error: 'Conflict: Pending installation already claimed' }, { status: 409 });
            }

            if (user.email && pendingRow.site_id) {
                await syncUserEmail(pendingRow, user.email);
            }
            return null;
        };

        const updateExistingRow = async (existingRow: TrmnlInstallation) => {
            const screens = extractTrmnlComponentScreens(existingRow.json);
            const carouselIndex = extractTrmnlCarouselIndex(existingRow.json, screens.length);
            const mergedInstallationJson = mergeTrmnlComponentScreensIntoInstallationJson(
                user,
                screens,
                carouselIndex
            );
            const updated = await service.updateWebhookMetadata(
                existingRow.id,
                user.uuid,
                existingRow.site_id,
                tokenPluginId,
                mergedInstallationJson
            );
            if (!updated) {
                return NextResponse.json(
                    { error: 'Conflict: Installation was modified or removed concurrently' },
                    { status: 409 }
                );
            }
            if (user.email && existingRow.site_id) {
                await syncUserEmail(existingRow, user.email);
            }
            return null;
        };

        if (matchedInstallation) {
            // Opaque token: carry the exact authenticated row through to the write.
            if (matchedInstallation.uuid === user.uuid) {
                const conflict = await updateExistingRow(matchedInstallation);
                if (conflict) return conflict;
            } else if (matchedInstallation.uuid === null) {
                const conflictOrRetry = await claimPendingRow(matchedInstallation);
                if (conflictOrRetry) return conflictOrRetry;
            } else {
                return NextResponse.json({ error: 'Conflict: Installation already claimed by another device' }, { status: 409 });
            }
        } else {
            // Signed JWT webhook: match by verified UUID or verified plugin_setting_id.
            // Never claim a loose pending row (NULL uuid, NULL plugin_setting_id) without correlation.
            const existing = await service.getInstallationByUuid(user.uuid);
            if (existing) {
                const conflict = await updateExistingRow(existing);
                if (conflict) return conflict;
            } else {
                const pending = await service.getInstallationByPendingPluginId(tokenPluginId);
                if (pending) {
                    const conflictOrRetry = await claimPendingRow(pending);
                    if (conflictOrRetry) return conflictOrRetry;
                } else {
                    console.warn(`[TrmnlWebhook] Received success webhook for unknown UUID: ${user.uuid} and unlinked Plugin ID: ${tokenPluginId}. Leaving any loose pending installations untouched.`);
                }
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
