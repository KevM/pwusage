
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

export function NewsNotificationIcon() {
    const [hasNew, setHasNew] = useState(false);

    useEffect(() => {
        const checkNews = async () => {
            try {
                const res = await fetch('/api/announcements?latest=true');
                if (!res.ok) return;
                const latest = await res.json();

                if (latest && latest.created_at) {
                    const lastRead = localStorage.getItem('last_news_read');
                    const latestDate = new Date(latest.created_at).getTime();

                    if (!lastRead || latestDate > parseInt(lastRead, 10)) {
                        setHasNew(true);
                    }
                }
            } catch (e) {
                console.error(e);
            }
        };
        checkNews();

        // Check every 3 hours
        const intervalId = setInterval(checkNews, 3 * 60 * 60 * 1000);

        return () => clearInterval(intervalId);
    }, []);

    const handleClick = () => {
        setHasNew(false);
        localStorage.setItem('last_news_read', Date.now().toString());
    };

    return (
        <Link
            href="/news"
            onClick={handleClick}
            className="relative flex items-center justify-center rounded-full transition-colors text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-slate-800"
            style={{ width: '40px', height: '40px', minWidth: '40px' }}
            title="News & Updates"
        >
            {hasNew && (
                <span className="absolute top-2 right-2 flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                </span>
            )}
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75v-.7V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
            </svg>
        </Link>
    );
}
