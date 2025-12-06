'use client';

import Link from 'next/link';
import Image from 'next/image';

export function GlobalHeader() {
    return (
        <header className="w-full bg-white dark:bg-slate-900 p-4 md:px-8">
            <div className="max-w-6xl mx-auto">
                <div className="flex flex-row items-center justify-between gap-4">
                    <Link href="/" className="flex items-center gap-3 group">
                        <div className="w-10 h-10 flex-shrink-0 relative overflow-hidden" style={{ width: '40px', height: '40px', minWidth: '40px', maxWidth: '40px' }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src="/icon.png"
                                alt="App Icon"
                                className="w-full h-full block object-cover group-hover:opacity-90 transition-opacity"
                                width={40}
                                height={40}
                            />
                        </div>
                        <h1 className="text-2xl md:text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300">
                            Powerwall Usage
                        </h1>
                    </Link>
                    <div className="flex gap-4 items-center">
                        <Link
                            href="/settings"
                            className="flex items-center justify-center rounded-full transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800"
                            aria-label="Settings"
                            style={{ width: '40px', height: '40px', minWidth: '40px' }}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6" style={{ minWidth: '24px' }}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                            </svg>
                        </Link>
                    </div>
                </div>
            </div>
        </header>
    );
}
