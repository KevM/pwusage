'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SystemAnnouncementsManager } from './SystemAnnouncementsManager';

// Define minimal user type based on usage in page.tsx
interface AdminUser {
    id: string;
    email?: string | null;
    is_active?: boolean;
    auth_status?: string;
    last_checked_at?: string | Date;
    has_trmnl_integration?: boolean;
    created_at?: string | number | Date;
    last_data_import?: string | number | Date | null;
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
    const [isChecking, setIsChecking] = useState(false);

    const handleCheckStatus = async () => {
        setIsChecking(true);
        try {
            const res = await fetch('/api/admin/users/check-status', { method: 'POST' });
            if (res.ok) {
                // Refresh the page data
                window.location.reload();
            } else {
                alert('Failed to check status');
            }
        } catch (e) {
            console.error(e);
            alert('Error checking status');
        } finally {
            setIsChecking(false);
        }
    };

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
                            <button
                                onClick={handleCheckStatus}
                                disabled={isChecking}
                                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded text-sm disabled:opacity-50"
                            >
                                {isChecking ? 'Checking...' : 'Check Status'}
                            </button>
                        </div>
                        <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
                            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                                <thead className="bg-gray-50 dark:bg-gray-900">
                                    <tr>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                            User
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                            Status
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                            Trmnl
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                            Sites
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                            Created
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                            Last Data
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
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="flex flex-col gap-1">
                                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${user.is_active
                                                        ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                                        : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                                                        }`}>
                                                        {user.is_active ? 'Active' : 'Inactive'}
                                                    </span>
                                                    {user.auth_status && (
                                                        <span className="text-xs text-gray-500 dark:text-gray-400">
                                                            {user.auth_status}
                                                        </span>
                                                    )}
                                                    {user.last_checked_at && (
                                                        <span className="text-[10px] text-gray-400">
                                                            Checked: {new Date(user.last_checked_at).toLocaleDateString()}
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${user.has_trmnl_integration
                                                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                                                    : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                                                    }`}>
                                                    {user.has_trmnl_integration ? 'Linked' : 'None'}
                                                </span>
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
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                                {(() => {
                                                    if (!user.created_at) return 'N/A';

                                                    try {
                                                        let date: Date;

                                                        if (typeof user.created_at === 'number') {
                                                            // Unix timestamp - if less than year 2100 in seconds, multiply by 1000
                                                            date = user.created_at < 4102444800
                                                                ? new Date(user.created_at * 1000)
                                                                : new Date(user.created_at);
                                                        } else {
                                                            date = new Date(user.created_at);
                                                        }

                                                        if (isNaN(date.getTime())) {
                                                            return 'Invalid';
                                                        }

                                                        return date.toLocaleDateString('en-US', {
                                                            year: 'numeric',
                                                            month: 'short',
                                                            day: 'numeric'
                                                        });
                                                    } catch {
                                                        return 'Error';
                                                    }
                                                })()}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                                {(() => {
                                                    if (!user.last_data_import) return 'N/A';

                                                    try {
                                                        const date = new Date(user.last_data_import);

                                                        if (isNaN(date.getTime())) {
                                                            return 'Invalid';
                                                        }

                                                        return date.toLocaleDateString('en-US', {
                                                            month: 'short',
                                                            day: 'numeric',
                                                            hour: 'numeric',
                                                            minute: '2-digit'
                                                        });
                                                    } catch {
                                                        return 'Error';
                                                    }
                                                })()}
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

