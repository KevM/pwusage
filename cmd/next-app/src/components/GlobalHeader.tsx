'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useParams } from 'next/navigation';
// SiteSwitcher import removed
import { HeaderLiveStats } from './HeaderLiveStats';
import { NewsNotificationIcon } from './NewsNotificationIcon';
import { Button } from '@/components/ui/Button';

interface GlobalHeaderProps {
    showStyleGuide?: boolean;
}

export function GlobalHeader({ showStyleGuide = false }: GlobalHeaderProps) {
    const params = useParams();
    const currentSiteIdParam = params?.id;
    const currentSiteId = Array.isArray(currentSiteIdParam) ? currentSiteIdParam[0] : currentSiteIdParam;

    return (
        <header className="w-full bg-white dark:bg-slate-900 p-4 md:px-8 shadow-sm">
            <div className="max-w-6xl mx-auto">
                <div className="flex flex-wrap md:flex-nowrap items-start md:items-center justify-between gap-x-4 gap-y-3">
                    {/* Logo Group - Always First */}
                    <div className="flex items-center gap-6 order-1 shrink-0">
                        <Link href="/" className="flex items-center gap-3 group shrink-0">
                            <div className="w-10 h-10 flex-shrink-0 relative overflow-hidden" style={{ width: '40px', height: '40px', minWidth: '40px', maxWidth: '40px' }}>
                                <Image
                                    src="/icon.png"
                                    alt="App Icon"
                                    className="w-full h-full block object-cover group-hover:opacity-90 transition-opacity"
                                    width={40}
                                    height={40}
                                />
                            </div>
                            <span className="hidden text-4xl font-bold tracking-tight text-primary md:block">
                                Powerwall Usage
                            </span>
                        </Link>
                    </div>

                    {/* Nav Icons Group - Order 2 on Mobile (Right of Logo), Order 3 on Desktop (Far Right) */}
                    <div className="flex gap-3 items-center order-2 md:order-3 shrink-0">
                        {showStyleGuide && (
                            <Link
                                href="/styleguide"
                                title="Style Guide"
                            >
                                <Button appearance="glyph" renderAs="span" className="hover:text-indigo-600 dark:hover:text-indigo-400">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 4.5l7.5 7.5-7.5 7.5m-6-15l7.5 7.5-7.5 7.5" />
                                    </svg>
                                </Button>
                            </Link>
                        )}

                        <Link
                            href="/profile"
                            title="User Profile"
                        >
                            <Button appearance="glyph" renderAs="span" className="hover:text-blue-600 dark:hover:text-blue-400">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                                </svg>
                            </Button>
                        </Link>

                        <NewsNotificationIcon />

                        <form action="/logout" method="POST">
                            <Button
                                type="submit"
                                appearance="glyph"
                                className="hover:text-red-600 dark:hover:text-red-400"
                                title="Logout"
                                aria-label="Logout"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
                                </svg>
                            </Button>
                        </form>
                    </div>

                    {/* Live Stats Group - Order 3 on Mobile (New Row), Order 2 on Desktop (Center) */}
                    {currentSiteId && currentSiteId !== 'undefined' && (
                        <div className="order-3 md:order-2 w-full md:flex-1 md:min-w-0 flex justify-center md:px-4 mt-1 md:mt-0">
                            <HeaderLiveStats siteId={currentSiteId} />
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}
