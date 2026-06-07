'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useParams, usePathname } from 'next/navigation';
// SiteSwitcher import removed
import { HeaderLiveStats } from './HeaderLiveStats';
import { NewsNotificationIcon } from './NewsNotificationIcon';
import { Button } from '@/components/ui/Button';

interface GlobalHeaderProps {
    showStyleGuide?: boolean;
}

export function GlobalHeader({ showStyleGuide = false }: GlobalHeaderProps) {
    const params = useParams();
    const pathname = usePathname();
    const currentSiteIdParam = params?.id;
    const currentSiteId = Array.isArray(currentSiteIdParam) ? currentSiteIdParam[0] : currentSiteIdParam;
    const onLiveDetail = Boolean(currentSiteId && pathname === `/site/${currentSiteId}/live`);
    const showLiveStats = Boolean(currentSiteId && currentSiteId !== 'undefined' && !onLiveDetail);

    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    // Close menu when navigating (state synchronization during render to avoid cascading effect renders)
    const [prevPathname, setPrevPathname] = useState(pathname);
    if (pathname !== prevPathname) {
        setPrevPathname(pathname);
        setIsMenuOpen(false);
    }

    // Close menu when clicking outside
    useEffect(() => {
        if (!isMenuOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (
                menuRef.current && !menuRef.current.contains(event.target as Node) &&
                buttonRef.current && !buttonRef.current.contains(event.target as Node)
            ) {
                setIsMenuOpen(false);
            }
        };

        const handleTouchOutside = (event: TouchEvent) => {
            if (
                menuRef.current && !menuRef.current.contains(event.target as Node) &&
                buttonRef.current && !buttonRef.current.contains(event.target as Node)
            ) {
                setIsMenuOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('touchstart', handleTouchOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('touchstart', handleTouchOutside);
        };
    }, [isMenuOpen]);

    return (
        <header className="w-full bg-white dark:bg-slate-900 p-4 md:px-8 shadow-sm relative">
            <div className="max-w-screen-2xl mx-auto">
                <div className="flex flex-nowrap items-center gap-x-2 md:gap-x-4 justify-between relative">
                    {/* Logo Group - Always First */}
                    <div className="flex items-center gap-6 shrink-0">
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
                            <span className="hidden text-3xl font-bold tracking-tight text-primary whitespace-nowrap min-[1400px]:block min-[1800px]:text-4xl">
                                Powerwall Usage
                            </span>
                        </Link>
                    </div>

                    {/* Live Stats Group - Centered in Middle */}
                    {showLiveStats && currentSiteId && (
                        <div className="flex-1 min-w-0 flex justify-center items-center md:px-4">
                            <HeaderLiveStats siteId={currentSiteId} />
                        </div>
                    )}

                    {/* Nav Icons / Hamburger Group - Always Last (Right-aligned) */}
                    <div className="flex justify-end items-center shrink-0">
                        {/* Hamburger Menu Toggle Button (Visible below md) */}
                        <button
                            ref={buttonRef}
                            onClick={() => setIsMenuOpen(!isMenuOpen)}
                            aria-expanded={isMenuOpen}
                            aria-label="Toggle navigation menu"
                            className="inline-flex md:hidden items-center justify-center rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 h-10 w-10 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer active:scale-95"
                        >
                            {isMenuOpen ? (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                                </svg>
                            )}
                        </button>

                        {/* Desktop/Landscape Nav Icons Group (Visible md and above) */}
                        <div className="flex max-md:hidden justify-end gap-3 items-center">
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
                    </div>
                </div>

                {/* Animated Mobile Dropdown Menu (disclosed right under the hamburger button, visible below md) */}
                <div
                    ref={menuRef}
                    className={`absolute top-[calc(100%-4px)] right-4 z-50 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 shadow-lg md:hidden p-1.5 rounded-2xl flex flex-col gap-1.5 items-center transition-all duration-200 ease-in-out ${
                        isMenuOpen
                            ? 'opacity-100 translate-y-2 visible scale-100'
                            : 'opacity-0 translate-y-0 invisible pointer-events-none scale-95'
                    }`}
                >
                    {showStyleGuide && (
                        <Link
                            href="/styleguide"
                            title="Style Guide"
                            onClick={() => setIsMenuOpen(false)}
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
                        onClick={() => setIsMenuOpen(false)}
                    >
                        <Button appearance="glyph" renderAs="span" className="hover:text-blue-600 dark:hover:text-blue-400">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                            </svg>
                        </Button>
                    </Link>

                    <NewsNotificationIcon onClick={() => setIsMenuOpen(false)} />

                    <form action="/logout" method="POST" onSubmit={() => setIsMenuOpen(false)}>
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
            </div>
        </header>
    );
}
