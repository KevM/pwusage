import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MeteredTariffEditor, type MeteredVersionSummary } from './MeteredTariffEditor';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const versions: MeteredVersionSummary[] = [
    { version: 2, effective_from: '2025-01-01', is_current: true, kind: 'tou', buy_rate: 0.3 },
    { version: 1, effective_from: '2020-01-15', is_current: false, kind: 'fixed', buy_rate: 0.16 },
];

describe('MeteredTariffEditor', () => {
    it('lists versions with their concrete effective dates, no undated/warning state', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toContain('2025-01-01');
        expect(html).toContain('2020-01-15');
        expect(html).toContain('current');
        // the retired guard copy must be gone
        expect(html).not.toMatch(/from the beginning/i);
        expect(html).not.toMatch(/set your current plan/i);
        expect(html).toContain('TOU');
        expect(html).toContain('0.16');
    });

    it('offers an "add historic plan" action (never disabled — no null state)', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toMatch(/add historic plan/i);
        expect(html).not.toContain('⚠️');
    });

    it('offers edit on each version', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toMatch(/edit/i);
    });

    it('attaches the "since" label to the version with the lowest effective_from date, even when it has a higher version number', () => {
        const invertedVersions: MeteredVersionSummary[] = [
            { version: 2, effective_from: '2025-01-01', is_current: true, kind: 'tou', buy_rate: 0.3 },
            { version: 1, effective_from: '2022-01-01', is_current: false, kind: 'fixed', buy_rate: 0.2 },
            { version: 3, effective_from: '2020-01-15', is_current: false, kind: 'fixed', buy_rate: 0.16 },
        ];
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={invertedVersions} />);
        expect(html).toContain('since 2020-01-15');
        expect(html).not.toContain('since 2022-01-01');
        expect(html).not.toContain('since 2025-01-01');
    });
});
