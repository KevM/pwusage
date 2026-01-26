'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { SystemAnnouncement } from '@/lib/announcement-repo';

interface LoginAnnouncementProps {
    announcement: SystemAnnouncement | null;
}

export function LoginAnnouncement({ announcement }: LoginAnnouncementProps) {
    const [visible, setVisible] = useState(true);

    const handleDismiss = () => {
        setVisible(false);
    };

    if (!visible || !announcement) return null;

    return (
        <div className="w-full max-w-lg mt-8 bg-white dark:bg-gray-800 border border-indigo-100 dark:border-gray-700 rounded-lg shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="p-4 border-b border-gray-100 dark:border-gray-700 flex justify-between items-center bg-indigo-50/50 dark:bg-gray-700/50">
                <div className="flex items-center space-x-2">
                    <span className="flex h-2 w-2 relative">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                    </span>
                    <h3 className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">
                        Latest Update
                    </h3>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                        • {new Date(announcement.created_at).toLocaleDateString()}
                    </span>
                </div>
                <button
                    onClick={handleDismiss}
                    className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
            <div className="p-4">
                <h4 className="text-base font-bold text-gray-900 dark:text-white mb-2">
                    {announcement.title}
                </h4>
                <div className="prose prose-sm dark:prose-invert max-w-none text-gray-600 dark:text-gray-300">
                    <ReactMarkdown>{announcement.content}</ReactMarkdown>
                </div>
            </div>
        </div>
    );
}
