import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

const m = vi.hoisted(() => ({
    refreshLivePage: vi.fn(),
    getRaw: vi.fn(),
    getLatest: vi.fn(),
    teslaLive: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: async () => true, getCurrentUser: async () => ({ id: 'u1' }) }));
vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite = async () => ({
            id: 's1', name: 'Home', timezone: 'UTC', billing_start_day: 1, tariffs: [], sankey_renderer: null,
            live_status_cache: { solar_power: 1200, load_power: 800, battery_power: 0, grid_power: -400, percentage_charged: 71, timestamp: new Date(Date.now() - 120_000).toISOString() },
            last_live_refresh_at: Date.now() - 120_000,
        });
    },
}));
vi.mock('@/lib/battery-hold-repo', () => ({
    BatteryHoldRepo: class { getActiveHold = async () => null; getLatestCancelledUnacked = async () => null; },
}));
vi.mock('@/lib/energy-repo-factory', () => ({
    createEnergyRepo: () => ({
        getRawEnergyData: m.getRaw,
        getLatestEnergyData: m.getLatest,
        getCycleAndTodayTotals: async () => ({ cycle: [], today: [] }),
        getUsageByTOU: async () => [],
        getBucketedEnergyData: async (_s: string, _a: Date, _b: Date, rows: unknown[]) => rows,
    }),
}));
vi.mock('@/lib/live-page-refresh', () => ({ refreshLivePage: m.refreshLivePage }));
// The page must never call Tesla while rendering the stored snapshot.
vi.mock('@/lib/today-refresh', () => ({ refreshTodayData: m.teslaLive, refreshLiveStatus: m.teslaLive }));
vi.mock('@/components/site/live/LiveDetailView', () => ({ LiveDetailView: function LiveDetailView() { return null; } }));
vi.mock('@/components/site/live/RefreshWhenChanged', () => ({ RefreshWhenChanged: function RefreshWhenChanged() { return null; } }));
vi.mock('@/components/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import SiteLivePage from './page';

type Element = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;

function find(node: ReactNode, name: string): Element | null {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
        for (const child of node) { const f = find(child, name); if (f) return f; }
        return null;
    }
    if (!('props' in node)) return null;
    const element = node as Element;
    const type = element.type as { name?: string } | string | symbol;
    if ((typeof type === 'function' && type.name === name) || (typeof type === 'symbol' && type.description === name)) return element;
    return find(element.props.children as ReactNode, name);
}

describe('Live page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m.getRaw.mockResolvedValue([]);
        m.getLatest.mockResolvedValue(null);
    });
    afterEach(() => vi.useRealTimers());

    it('renders the stored snapshot without waiting for a slow Tesla response', async () => {
        let finishTesla: (value: { changed: boolean }) => void = () => undefined;
        m.refreshLivePage.mockReturnValue(new Promise(resolve => { finishTesla = resolve; }));

        const tree = await SiteLivePage({ params: Promise.resolve({ id: 's1' }), searchParams: Promise.resolve({}) });

        // The page resolved while the Tesla refresh is still pending.
        const view = find(tree as ReactNode, 'LiveDetailView');
        expect(view?.props.batterySoC).toBe(71);
        expect(view?.props.solarPower).toBe(1200);
        expect(m.teslaLive).not.toHaveBeenCalled();

        // The refresh sits behind a Suspense boundary with a timestamped fallback.
        const boundary = find(tree as ReactNode, 'react.suspense');
        expect(boundary).not.toBeNull();
        const fallback = boundary!.props.fallback as Element;
        expect(fallback.props.checking).toBe(true);
        expect(fallback.props.asOf).toBeInstanceOf(Date);

        // Once Tesla answers, the streamed part asks the open page to re-render.
        const refresher = find(boundary!.props.children as ReactNode, 'LiveDataRefresh')!;
        const render = (refresher.type as (p: unknown) => Promise<Element>)(refresher.props);
        finishTesla({ changed: true });
        expect((await render).props.changed).toBe(true);
    });

    it('reads today\'s raw history once', async () => {
        m.refreshLivePage.mockResolvedValue({ changed: false });
        await SiteLivePage({ params: Promise.resolve({ id: 's1' }), searchParams: Promise.resolve({}) });
        expect(m.getRaw).toHaveBeenCalledTimes(1);
    });
});
