'use client';

import Link from 'next/link';


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
                </div>
            </div>
        </header>
    );
}
