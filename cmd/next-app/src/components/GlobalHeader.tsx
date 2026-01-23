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
                        {currentSiteId && (
                            <Link
                                href={`/site/${currentSiteId}/settings`}
                                className="flex items-center justify-center rounded-full transition-colors text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-slate-800"
                                style={{ width: '40px', height: '40px', minWidth: '40px' }}
                                title="Site Settings"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                            </Link>
                        )}

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
