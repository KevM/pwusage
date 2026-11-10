import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SiteWithTariffs, TrmnlInstallation } from '@/lib/db';
import { SettingsView } from './SettingsView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/qr-generator', () => ({ drawQrWithLogo: vi.fn() }));
vi.mock('@/components/BillingStartDayForm', () => ({ BillingStartDayForm: () => null }));
vi.mock('@/components/TimezoneDisplayForm', () => ({ TimezoneDisplayForm: () => null }));
vi.mock('@/components/SankeyRendererForm', () => ({ SankeyRendererForm: () => null }));
vi.mock('./TariffList', () => ({ TariffList: () => null }));
vi.mock('@/components/trmnl/TrmnlLivePreview', () => ({ TrmnlLivePreview: () => null }));

const site = { id: 'site-1', tariffs: [] } as unknown as SiteWithTariffs;

const inst = (over: Record<string, unknown>) =>
    ({ id: 1, uuid: null, plugin_setting_id: null, created_at: new Date('2026-11-10T18:00:00Z'), json: null, ...over }) as unknown as TrmnlInstallation;

const render = (installations: TrmnlInstallation[]) =>
    renderToStaticMarkup(
        <SettingsView site={site} installations={installations} memberEmails={[]} />
    );

describe('SettingsView Trmnl devices', () => {
    it('lists every connected device with its own Trmnl and screens links', () => {
        const html = render([
            inst({ id: 2, uuid: 'd3d3a24c-698f-4de9-b540-63122177d079', plugin_setting_id: 537263 }),
            inst({ id: 1, uuid: '8145deda-d663-47b1-8de9-246c876f8684', plugin_setting_id: 197842 }),
        ]);
        expect(html).toContain('href="https://trmnl.com/plugin_settings/537263/edit"');
        expect(html).toContain('href="https://trmnl.com/plugin_settings/197842/edit"');
        expect(html).toContain('href="/trmnl/manage?uuid=d3d3a24c-698f-4de9-b540-63122177d079"');
        expect(html).toContain('href="/trmnl/manage?uuid=8145deda-d663-47b1-8de9-246c876f8684"');
        expect(html).toContain('d3d3a24c');
        expect(html).toContain('8145deda');
        expect(html).toContain('Add another device');
    });

    it('hides installs that have not finished connecting', () => {
        const html = render([
            inst({ id: 2, uuid: 'aaaaaaaa-0000-0000-0000-000000000000', plugin_setting_id: 111 }),
            inst({ id: 3, uuid: null, plugin_setting_id: null }),
            inst({ id: 4, uuid: 'bbbbbbbb-0000-0000-0000-000000000000', plugin_setting_id: null }),
        ]);
        expect(html).toContain('plugin_settings/111/edit');
        expect(html).not.toContain('bbbbbbbb');
    });

    it('offers to add the plugin when nothing is connected', () => {
        const html = render([]);
        expect(html).toContain('href="https://trmnl.com/plugin_settings/new?keyname=powerwall_energy_usage"');
        expect(html).toContain('Add Trmnl Plugin');
        expect(html).not.toContain('Add another device');
    });
});
