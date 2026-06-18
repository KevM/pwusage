import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MeteredTariffEditor, type MeteredVersionSummary } from './MeteredTariffEditor';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const versions: MeteredVersionSummary[] = [
    { version: 2, effective_from: '2026-01-01', is_current: true, kind: 'tou', buy_rate: 0.3 },
    { version: 1, effective_from: null, is_current: false, kind: 'fixed', buy_rate: 0.16 },
];

describe('MeteredTariffEditor', () => {
    it('lists metered versions with their effective dates, newest first', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toContain('2026-01-01');
        expect(html).toContain('current');
        // the undated earliest version is presented as the carry-back anchor
        expect(html).toMatch(/from the beginning/i);
        // TOU current version shows a TOU badge; the fixed one shows a rate
        expect(html).toContain('TOU');
        expect(html).toContain('0.16000');
    });

    it('disables the add button and shows a warning when there is an undated version', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toContain('disabled=""');
        expect(html).toContain("set your current plan&#x27;s start date first");
    });

    it('enables the add button and hides warning when all versions are dated', () => {
        const datedVersions: MeteredVersionSummary[] = [
            { version: 2, effective_from: '2026-01-01', is_current: true, kind: 'tou', buy_rate: 0.3 },
            { version: 1, effective_from: '2024-01-01', is_current: false, kind: 'fixed', buy_rate: 0.16 },
        ];
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={datedVersions} />);
        expect(html).not.toContain('disabled=""');
        expect(html).not.toContain("set your current plan&#x27;s start date first");
    });
});
