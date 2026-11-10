import { describe, expect, it } from 'vitest';
import type { TrmnlInstallation } from './db';
import { extractPluginSettingId, toTrmnlDevices } from './trmnl-devices';

function installation(overrides: Partial<TrmnlInstallation>): TrmnlInstallation {
    return {
        id: 1,
        uuid: 'abcdef12-0000-4000-8000-000000000000',
        site_id: 'site-1',
        plugin_setting_id: null,
        json: null,
        created_at: new Date('2026-11-03T15:00:00Z'),
        ...overrides
    } as TrmnlInstallation;
}

describe('extractPluginSettingId', () => {
    it('prefers the stored plugin setting id', () => {
        expect(extractPluginSettingId(installation({ plugin_setting_id: 7 }))).toBe(7);
    });

    it('falls back to the installation payload', () => {
        expect(extractPluginSettingId(installation({ json: { plugin_setting_id: 8 } }))).toBe(8);
        expect(extractPluginSettingId(installation({ json: { user: { plugin_setting_id: '9' } } }))).toBe(9);
        expect(extractPluginSettingId(installation({
            json: JSON.stringify({ installation_callback_url: 'https://trmnl.com/plugin_settings/10/install' })
        }))).toBe(10);
    });

    it('returns null when nothing identifies the plugin', () => {
        expect(extractPluginSettingId(installation({ json: 'not json' }))).toBeNull();
        expect(extractPluginSettingId(null)).toBeNull();
    });
});

describe('toTrmnlDevices', () => {
    it('lists only finished installs, in the order given', () => {
        const devices = toTrmnlDevices([
            installation({ id: 2, uuid: 'bbbbbbbb-0000', plugin_setting_id: 20 }),
            installation({ id: 3, uuid: null as unknown as string, plugin_setting_id: 30 }),
            installation({ id: 4, uuid: 'cccccccc-0000', plugin_setting_id: null }),
            installation({ id: 5, uuid: 'dddddddd-0000', json: { plugin_setting_id: 50 } })
        ]);
        expect(devices.map(d => d.id)).toEqual([2, 5]);
        expect(devices[0]).toMatchObject({
            id: 2,
            uuid: 'bbbbbbbb-0000',
            pluginSettingId: 20,
            connectedAt: '2026-11-03T15:00:00.000Z'
        });
    });

    it('tolerates string and invalid created_at values', () => {
        const [fromString, invalid] = toTrmnlDevices([
            installation({ id: 1, plugin_setting_id: 1, created_at: '2026-11-03T15:00:00Z' as unknown as Date }),
            installation({ id: 2, plugin_setting_id: 2, created_at: 'nope' as unknown as Date })
        ]);
        expect(fromString.connectedAt).toBe('2026-11-03T15:00:00.000Z');
        expect(invalid.connectedAt).toBeNull();
    });
});

describe('toTrmnlDevices current screen', () => {
    const screens = [
        { id: 'a', name: 'Overview', componentConfig: { showLiveGrid: true } },
        { id: 'b', name: 'Bill', componentConfig: { showEstimatedBill: true } },
        { id: 'c', name: 'Chart', componentConfig: { showEnergyChart: true } }
    ];

    function withRotation(carouselIndex: unknown) {
        return installation({
            plugin_setting_id: 5,
            json: { component_screens: screens, carousel_index: carouselIndex }
        });
    }

    it('reports the screen last sent, because the stored index points at the next one', () => {
        const [device] = toTrmnlDevices([withRotation(2)]);
        expect(device.screen).toMatchObject({ name: 'Bill', index: 1, count: 3 });
        expect(device.screen.componentConfig.showEstimatedBill).toBe(true);
    });

    it('wraps to the last screen when the rotation is back at the start', () => {
        const [device] = toTrmnlDevices([withRotation(0)]);
        expect(device.screen).toMatchObject({ name: 'Chart', index: 2, count: 3 });
    });

    it('falls back to the default screen for an install that was never configured', () => {
        const [device] = toTrmnlDevices([installation({ plugin_setting_id: 5, json: null })]);
        expect(device.screen).toMatchObject({ index: 0, count: 1 });
        expect(device.screen.componentConfig).toHaveProperty('batterySocMode');
    });
});
