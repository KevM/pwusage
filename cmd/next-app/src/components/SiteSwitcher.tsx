'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';

interface Site {
    id: string;
    name: string;
}

export function SiteSwitcher({ sites }: { sites: Site[] }) {
    const params = useParams();
    const router = useRouter();
    const currentSiteId = params?.id as string;
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const currentSite = sites.find(s => s.id === currentSiteId) || sites[0];

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    const handleSiteClick = (siteId: string) => {
        setIsOpen(false);
        router.push(`/site/${siteId}`);
    };

    // if (sites.length <= 1) {
    //     return null;
    // }

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
                aria-haspopup="true"
                aria-expanded={isOpen}
            >
                <span className="font-semibold text-gray-900 dark:text-white max-w-[150px] md:max-w-[200px] truncate">
                    {currentSite?.name || 'Select Site'}
                </span>
                <svg
                    className={`w-4 h-4 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 mt-1 w-56 bg-white dark:bg-slate-900 rounded-lg shadow-lg border border-gray-200 dark:border-slate-700 py-1 z-50">
                    {sites.map((site) => (
                        <button
                            key={site.id}
                            onClick={() => handleSiteClick(site.id)}
                            className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors
                                ${site.id === currentSiteId ? 'text-blue-600 font-medium' : 'text-gray-700 dark:text-gray-300'}
                            `}
                        >
                            {site.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
