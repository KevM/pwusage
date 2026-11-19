'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ReactNode, useEffect, useRef } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { isSiteTabId, type SiteTabId } from '@/lib/site-tabs';

const LAST_TAB_KEY = 'pwusage_last_site_tab';

interface SiteTabsProps {
    /** The tab the server rendered (from `?view=`). Only its content is passed in. */
    activeTab: SiteTabId;
    /** The active tab's content. */
    children: ReactNode;
    breadcrumbs?: ReactNode;
}

function readLastTab(): SiteTabId | null {
    try {
        const value = localStorage.getItem(LAST_TAB_KEY);
        return isSiteTabId(value) ? value : null;
    } catch {
        return null;
    }
}

function rememberTab(tab: SiteTabId) {
    try {
        localStorage.setItem(LAST_TAB_KEY, tab);
    } catch {
        // Private windows can refuse storage; the tab still opens.
    }
}

export function SiteTabs({ activeTab, children, breadcrumbs }: SiteTabsProps) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const initialized = useRef(false);

    useEffect(() => {
        // Only run once on mount
        if (initialized.current) return;
        initialized.current = true;

        // With no view in the URL, reopen the last tab the person chose.
        if (!searchParams.has('view')) {
            const lastTab = readLastTab();
            if (lastTab && lastTab !== activeTab) {
                const params = new URLSearchParams(searchParams);
                params.set('view', lastTab);
                router.replace(`${pathname}?${params.toString()}`);
            }
        }
    }, [activeTab, pathname, router, searchParams]);

    // Each tab is its own server render, so the URL (and back/forward) decides what loads.
    const setTab = (tab: SiteTabId) => {
        rememberTab(tab);
        const params = new URLSearchParams(searchParams);
        params.set('view', tab);
        router.push(`${pathname}?${params.toString()}`);
    };

    return (
        <div className="w-full">
            <div className="relative flex flex-col md:flex-row items-center justify-center mb-6">
                {/* Left: Breadcrumbs - positioned absolute on large screens */}
                {breadcrumbs && (
                    <div className="w-full md:w-auto md:absolute md:left-0 md:top-1/2 md:-translate-y-1/2 z-10 mb-4 md:mb-0">
                        {breadcrumbs}
                    </div>
                )}

                {/* Center: Tabs */}
                <div className="z-0">
                    <Tabs value={activeTab} onValueChange={(value) => { if (isSiteTabId(value)) setTab(value); }}>
                        <TabsList className="overflow-x-auto max-w-full">
                            <TabsTrigger value="history" className="flex items-center gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
                                </svg>
                                History
                            </TabsTrigger>
                            <TabsTrigger value="bill" className="flex items-center gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                                </svg>
                                Estimated Bill
                            </TabsTrigger>
                            <TabsTrigger value="settings" className="flex items-center gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                                Settings
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
            </div>

            <div className="mt-4">
                {children}
            </div>
        </div>
    );
}
