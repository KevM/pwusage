'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useParams } from 'next/navigation';
// SiteSwitcher import removed
import { HeaderLiveStats } from './HeaderLiveStats';
import { NewsNotificationIcon } from './NewsNotificationIcon';

export function GlobalHeader() {
    const params = useParams();
    const currentSiteId = params?.id as string | undefined;

    return (
        <header className="w-full bg-white dark:bg-slate-900 p-4 md:px-8 shadow-sm">
            <div className="max-w-6xl mx-auto">
                <div className="flex flex-wrap md:flex-nowrap items-center justify-between gap-x-4 gap-y-3">
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
                            <h1 className="hidden md:block text-2xl md:text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300">
                                Powerwall Usage
                            </h1>
                        </Link>
                    </div>

                    {/* Nav Icons Group - Order 2 on Mobile (Right of Logo), Order 3 on Desktop (Far Right) */}
                    <div className="flex gap-3 items-center order-2 md:order-3 shrink-0">


                        <Link
                            href="/profile"
                            className="flex items-center justify-center rounded-full transition-colors text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-slate-800"
                            style={{ width: '40px', height: '40px', minWidth: '40px' }}
                            title="User Profile"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                            </svg>
                        </Link>

                        <NewsNotificationIcon />

                        <form action="/logout" method="POST">
                            <button
                                type="submit"
                                className="flex items-center justify-center rounded-full transition-colors text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-slate-800"
                                style={{ width: '40px', height: '40px', minWidth: '40px' }}
                                title="Logout"
                                aria-label="Logout"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
                                </svg>
                            </button>
                        </form>
                    </div>

                    {/* Live Stats Group - Order 3 on Mobile (New Row), Order 2 on Desktop (Center) */}
                    {currentSiteId && (
                        <div className="order-3 md:order-2 w-full md:w-auto flex justify-center mt-2 md:mt-0">
                            <HeaderLiveStats siteId={currentSiteId} />
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}
