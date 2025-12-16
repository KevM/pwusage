import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';

export async function POST(request: Request) {
    try {

        const body = await request.json();
        const { user } = body;

        if (!user || !user.uuid) {
            console.error('[TrmnlWebhook] Invalid payload:', JSON.stringify(body));
            return NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 });
        }

        console.log(`[TrmnlWebhook] Received webhook for UUID: ${user.uuid}, Plugin ID: ${user.plugin_setting_id}`);

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

        const existing = await service.getInstallationByUuid(user.uuid);
        if (existing) {
            // Update with new details
            await service.createInstallation(existing.site_id, user.uuid, user.plugin_setting_id, user);
        } else {
            // 1. Check for Pending installation by plugin_setting_id (Strong Link)
            let pending = await service.getInstallationByPendingPluginId(user.plugin_setting_id);

            // 2. Fallback: Check for "Loose" Pending installation (NULL UUID, NULL PluginID)
            // We take the MOST RECENT one.
            if (!pending) {
                pending = await service.getLatestLoosePendingInstallation();
            }

            if (pending) {
                console.log(`[TrmnlWebhook] Claiming pending installation (ID: ${pending.id}) for plugin ${user.plugin_setting_id} / UUID ${user.uuid}`);
                // If it was a "loose" pending record, it might not have the plugin_setting_id set either.
                // We update it with BOTH.
                // We pass the pending record's ID to ensure we update the correct row if we add a method for ID-based update, 
                // OR we rely on claimPending... but claimPendingPluginId queries by plugin_setting_id.
                // We need a new method to claim by Row ID.
                await service.claimPendingInstallationById(pending.id, user.uuid, user.plugin_setting_id, user);
            } else {
                console.warn(`[TrmnlWebhook] Received success webhook for unknown UUID: ${user.uuid} and unknown Plugin ID: ${user.plugin_setting_id}. details ignored.`);
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
