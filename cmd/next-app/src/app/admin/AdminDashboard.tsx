'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SystemAnnouncementsManager } from './SystemAnnouncementsManager';

// Define minimal user type based on usage in page.tsx
interface AdminUser {
    id: string;
    email?: string | null;
    sites: {
        id: string;
        name: string;
    }[];
}

interface AdminDashboardProps {
    users: AdminUser[];
}

export function AdminDashboard({ users }: AdminDashboardProps) {
    const [activeTab, setActiveTab] = useState<'users' | 'announcements'>('users');

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <h1 className="text-3xl font-bold mb-8">Admin Dashboard</h1>

            {/* Tabs */}
            <div className="border-b border-gray-200 dark:border-gray-700 mb-8">
                <nav className="-mb-px flex space-x-8">
                    <button
                        onClick={() => setActiveTab('users')}
                        className={`
                            whitespace-nowrap pb-4 px-1 border-b-2 font-medium text-sm
                            ${activeTab === 'users'
                                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'}
                        `}
                    >
                        Users
                    </button>
                    <button
                        onClick={() => setActiveTab('announcements')}
                        className={`
                            whitespace-nowrap pb-4 px-1 border-b-2 font-medium text-sm
                            ${activeTab === 'announcements'
                                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'}
                        `}
                    >
                        System Announcements
                    </button>
                </nav>
            </div>

            {/* Content */}
            <div>
                {activeTab === 'users' && (
                    <div>
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-xl font-semibold">Users ({users.length})</h2>
                        </div>
                        <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
                            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                                <thead className="bg-gray-50 dark:bg-gray-900">
                                    <tr>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                            User
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                            Actions
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                                    {users.map((user) => (
                                        <tr key={user.id}>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm font-medium text-gray-900 dark:text-white">
                                                    {user.email || 'No Email'}
                                                </div>
                                                <div className="text-xs text-gray-500 dark:text-gray-400">
                                                    {user.id}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                                <div className="flex flex-col gap-1">
                                                    {user.sites.length > 0 ? (
                                                        user.sites.map(site => (
                                                            <Link
                                                                key={site.id}
                                                                href={`/site/${site.id}`}
                                                                className="text-indigo-600 hover:text-indigo-900 dark:text-indigo-400 dark:hover:text-indigo-300 text-xs"
                                                            >
                                                                {site.name}
                                                            </Link>
                                                        ))
                                                    ) : (
                                                        <span className="text-xs text-gray-400 italic">No Sites</span>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {activeTab === 'announcements' && (
                    <SystemAnnouncementsManager />
                )}
            </div>
        </div>
    );
}
