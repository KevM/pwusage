'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ReactNode, useEffect, useRef } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { track } from '@/lib/analytics';

type TabId = 'history' | 'bill' | 'settings';

interface SiteTabsProps {
    children?: ReactNode; // We might not need children if we pass slots, or we use children as content
    siteId: string;
    hasBatteryHold?: boolean;
    historySlot: ReactNode;
    billSlot: ReactNode;
    settingsSlot: ReactNode;
    breadcrumbs?: ReactNode;
}

export function SiteTabs({ siteId, hasBatteryHold = false, historySlot, billSlot, settingsSlot, breadcrumbs }: SiteTabsProps) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    // Default to 'bill' as it was the main page content previously? 
    // Or user asked for History, Bill, Settings. Let's default to History or Bill.
    // Given the prompt "History: remove chart... Estimated Bill: site page currently has this",
    // maybe 'bill' is a safer default for existing users, or 'history'.
    // Let's default to 'bill' as it feels like the "Dashboard".
    const activeTab = (searchParams.get('view') as TabId) || 'bill';
    const initialized = useRef(false);

    useEffect(() => {
        // Only run once on mount
        if (initialized.current) return;
        initialized.current = true;

        track('site-loaded', { site_id: siteId, has_battery_hold: hasBatteryHold });

        // If no view is specified in URL, check localStorage
        if (!searchParams.has('view')) {
            const lastTab = localStorage.getItem('pwusage_last_site_tab') as TabId;
            if (lastTab && ['history', 'bill', 'settings'].includes(lastTab) && lastTab !== 'bill') {
                const params = new URLSearchParams(searchParams);
                params.set('view', lastTab);
                router.replace(`${pathname}?${params.toString()}`);
            }
        }
        // intentionally only on mount
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const setTab = (tab: TabId) => {
        track('site-tab-changed', { site_id: siteId, tab_name: tab });
        localStorage.setItem('pwusage_last_site_tab', tab);
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
                    <Tabs value={activeTab} onValueChange={(value) => setTab(value as TabId)}>
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
                <Tabs value={activeTab} onValueChange={(value) => setTab(value as TabId)}>
                    <TabsContent value="history">
                    {historySlot}
                    </TabsContent>
                    <TabsContent value="bill">
                    {billSlot}
                    </TabsContent>
                    <TabsContent value="settings">
                    {settingsSlot}
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}
