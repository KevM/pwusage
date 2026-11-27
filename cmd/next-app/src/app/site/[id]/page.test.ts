import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

const { loadMock, memberEmailsMock, timelineMock, currentUserMock, connectionMock } = vi.hoisted(() => ({
    loadMock: vi.fn(),
    memberEmailsMock: vi.fn(),
    timelineMock: vi.fn(),
    currentUserMock: vi.fn(),
    connectionMock: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'token' }) }) }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class {} }));
vi.mock('@/lib/site-service', () => ({ SiteService: class { loadSitePageData = loadMock; } }));
vi.mock('@/lib/user-repo', () => ({ UserRepo: class { getSiteMemberEmails = memberEmailsMock; } }));
vi.mock('@/lib/tariff-timeline-repo', () => ({ TariffTimelineRepo: class { getTimeline = timelineMock; } }));
vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: currentUserMock }));
vi.mock('@/lib/tesla-client-factory', () => ({ getSiteConnectionTokens: connectionMock }));
vi.mock('@/lib/tesla-refresh-outcome', () => ({ requiresTeslaReconnect: () => false }));
// Client components are opaque here: the test inspects which one the page chose.
vi.mock('@/components/site/SiteTabPanels', () => ({
    LazyHistoryTab: function LazyHistoryTab() { return null; },
    LazySettingsView: function LazySettingsView() { return null; },
}));
vi.mock('@/components/site/SiteTabs', () => ({ SiteTabs: function SiteTabs() { return null; } }));
vi.mock('@/components/site/EstimatedBillView', () => ({ EstimatedBillView: function EstimatedBillView() { return null; } }));
vi.mock('@/components/BillSummary', () => ({ BillSummary: () => null }));
vi.mock('@/components/BillDateNav', () => ({ BillDateNav: () => null }));
vi.mock('@/components/DataSyncer', () => ({ DataSyncer: () => null }));
vi.mock('@/components/SiteSetup', () => ({ SiteSetup: () => null }));

import SitePage from './page';

function readyResult(view: string) {
    return {
        status: 'ready',
        site: { id: 's1', name: 'Home', timezone: 'UTC', timezone_display_mode: 'SITE', tariffs: [] },
        installation: undefined,
        installations: view === 'settings' ? [] : null,
        billingDay: 1, prevDateStr: '2026-10-01', nextDateStr: '2026-12-01', isCurrentPeriod: true,
        dateRangeLabel: 'Nov 1 - Dec 1, 2026', currentMonthVal: '2026-11', fullBillDateStr: '2026-11-01',
        usage: view === 'bill' ? [] : null, historyRevision: view === 'bill' ? 'rev-1' : null, activeTariffId: undefined, activeTouName: undefined,
        currencySymbol: '$', dateStr: '2026-11-19',
        start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z'), refDate: new Date('2026-11-19T00:00:00Z'),
    };
}

type Element = ReactElement<{ children?: ReactNode; activeTab?: string }>;

/** The SiteTabs element in the page tree, and the single panel it holds. */
function findTabs(node: ReactNode): Element | null {
    if (!node || typeof node !== 'object' || !('props' in node)) return null;
    const element = node as Element;
    if (typeof element.type === 'function' && element.type.name === 'SiteTabs') return element;
    const children = element.props.children;
    for (const child of Array.isArray(children) ? children : [children]) {
        const found = findTabs(child as ReactNode);
        if (found) return found;
    }
    return null;
}

async function render(view?: string, section?: string) {
    loadMock.mockResolvedValue(readyResult(view === 'history' || view === 'settings' ? view : 'bill'));
    const tree = await SitePage({
        params: Promise.resolve({ id: 's1' }),
        searchParams: Promise.resolve({ view, section }),
    });
    const tabs = findTabs(tree as ReactNode);
    const panel = tabs?.props.children as ReactElement | undefined;
    return { tabs, panelProps: panel?.props, panelName: (panel?.type as { name?: string } | undefined)?.name };
}

describe('site page tabs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectionMock.mockResolvedValue({ refresh_token: 'r' });
        memberEmailsMock.mockResolvedValue(['a@example.com']);
        currentUserMock.mockResolvedValue({ id: 'u1' });
        timelineMock.mockResolvedValue(null);
    });

    it('a default visit renders the bill with no Settings reads', async () => {
        const { tabs, panelName } = await render();
        expect(loadMock).toHaveBeenCalledWith('s1', undefined, { view: 'bill' });
        expect(tabs?.props.activeTab).toBe('bill');
        expect(panelName).toBe('EstimatedBillView');
        expect(memberEmailsMock).not.toHaveBeenCalled();
        expect(timelineMock).not.toHaveBeenCalled();
        expect(currentUserMock).not.toHaveBeenCalled();
    });

    it('an unknown view falls back to the bill', async () => {
        const { tabs } = await render('nonsense');
        expect(tabs?.props.activeTab).toBe('bill');
        expect(loadMock).toHaveBeenCalledWith('s1', undefined, { view: 'bill' });
    });

    it('history renders the lazily loaded chart and no Settings reads', async () => {
        const { tabs, panelName } = await render('history');
        expect(tabs?.props.activeTab).toBe('history');
        expect(panelName).toBe('LazyHistoryTab');
        expect(memberEmailsMock).not.toHaveBeenCalled();
        expect(timelineMock).not.toHaveBeenCalled();
    });

    it('the Settings overview skips section-specific reads', async () => {
        const { panelName, panelProps } = await render('settings');
        expect(panelName).toBe('LazySettingsView');
        expect(panelProps).toMatchObject({ section: null });
        expect(loadMock).toHaveBeenCalledWith('s1', undefined, { view: 'settings', settingsSection: null });
        expect(memberEmailsMock).not.toHaveBeenCalled();
        expect(timelineMock).not.toHaveBeenCalled();
    });

    it('People reads only member emails', async () => {
        const { panelProps } = await render('settings', 'people');
        expect(panelProps).toMatchObject({ section: 'people', memberEmails: ['a@example.com'] });
        expect(memberEmailsMock).toHaveBeenCalledWith('s1');
        expect(timelineMock).not.toHaveBeenCalled();
    });

    it('Billing reads its rate plan timeline and skips member emails', async () => {
        const { panelProps } = await render('settings', 'billing');
        expect(panelProps).toMatchObject({ section: 'billing' });
        expect(timelineMock).toHaveBeenCalledWith('s1', 'u1');
        expect(memberEmailsMock).not.toHaveBeenCalled();
    });

    it('Connections requests TRMNL installations from the site service', async () => {
        const { panelProps } = await render('settings', 'connections');
        expect(panelProps).toMatchObject({ section: 'connections' });
        expect(loadMock).toHaveBeenCalledWith('s1', undefined, { view: 'settings', settingsSection: 'connections' });
        expect(memberEmailsMock).not.toHaveBeenCalled();
        expect(timelineMock).not.toHaveBeenCalled();
    });

    it('an unknown settings section opens the overview', async () => {
        const { panelProps } = await render('settings', 'nonsense');
        expect(panelProps).toMatchObject({ section: null });
        expect(memberEmailsMock).not.toHaveBeenCalled();
        expect(timelineMock).not.toHaveBeenCalled();
    });
});
