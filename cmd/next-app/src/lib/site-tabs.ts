/** The tabs of `/site/[id]`. The selected one decides which reads and client code the page loads. */
export type SiteTabId = 'history' | 'bill' | 'settings';

export const SITE_TAB_IDS: readonly SiteTabId[] = ['history', 'bill', 'settings'];

/** Estimated Bill is the default; anything unknown falls back to it. */
export const DEFAULT_SITE_TAB: SiteTabId = 'bill';

export function isSiteTabId(value: unknown): value is SiteTabId {
    return typeof value === 'string' && (SITE_TAB_IDS as readonly string[]).includes(value);
}

export function parseSiteTab(view: string | null | undefined): SiteTabId {
    return isSiteTabId(view) ? view : DEFAULT_SITE_TAB;
}
