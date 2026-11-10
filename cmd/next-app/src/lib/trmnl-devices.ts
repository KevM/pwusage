import type { TrmnlInstallation } from './db';
import {
    coercePositiveInt,
    extractTrmnlCarouselIndex,
    extractTrmnlComponentScreens,
    type TrmnlComponentConfig
} from './trmnl-component-config';

/** The screen a device is showing, out of the screens it rotates through. */
export interface TrmnlDeviceScreen {
    name: string;
    /** Zero-based position in the rotation. */
    index: number;
    count: number;
    componentConfig: TrmnlComponentConfig;
}

/** A Trmnl device that finished connecting to a site. Safe to send to clients: no tokens. */
export interface TrmnlDevice {
    id: number;
    uuid: string;
    pluginSettingId: number;
    /** ISO timestamp, or null when the stored value is not a date. */
    connectedAt: string | null;
    screen: TrmnlDeviceScreen;
}

function parseInstallationJson(value: unknown): Record<string, unknown> | null {
    if (!value) return null;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : null;
        } catch {
            return null;
        }
    }
    return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function extractPluginSettingId(installation: TrmnlInstallation | null | undefined): number | null {
    if (!installation) return null;
    if (installation.plugin_setting_id) return installation.plugin_setting_id;

    const json = parseInstallationJson(installation.json);
    if (!json) return null;

    const topLevel = coercePositiveInt(json.plugin_setting_id);
    if (topLevel) return topLevel;

    const user = json.user;
    if (user && typeof user === 'object' && !Array.isArray(user)) {
        const nested = coercePositiveInt((user as Record<string, unknown>).plugin_setting_id);
        if (nested) return nested;
    }

    const callbackUrl = typeof json.installation_callback_url === 'string' ? json.installation_callback_url : null;
    const match = callbackUrl?.match(/\/plugin_settings\/(\d+)/);
    return match ? coercePositiveInt(match[1]) : null;
}

/**
 * The screen the device last fetched. Each poll renders the screen at the stored rotation index and then
 * moves the index on, so the stored index names the next screen and the one before it is on the device.
 */
function currentScreen(installation: TrmnlInstallation): TrmnlDeviceScreen {
    const screens = extractTrmnlComponentScreens(installation.json);
    const next = extractTrmnlCarouselIndex(installation.json, screens.length);
    const index = (next - 1 + screens.length) % screens.length;
    const { name, componentConfig } = screens[index];
    return { name, index, count: screens.length, componentConfig };
}

function isoDate(value: Date | string): string | null {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Only devices that finished connecting; pending rows have nothing to open yet. */
export function toTrmnlDevices(installations: TrmnlInstallation[]): TrmnlDevice[] {
    return installations.flatMap(installation => {
        const pluginSettingId = extractPluginSettingId(installation);
        if (!installation.uuid || !pluginSettingId) return [];
        return [{
            id: installation.id,
            uuid: installation.uuid,
            pluginSettingId,
            connectedAt: isoDate(installation.created_at),
            screen: currentScreen(installation)
        }];
    });
}
