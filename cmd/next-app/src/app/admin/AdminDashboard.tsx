'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { SectionCard } from '@/components/ui/SectionCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { StatusPill } from '@/components/ui/StatusPill';
import { SystemAnnouncementsManager } from './SystemAnnouncementsManager';
import { SiteHistoryTable, type SiteHistoryRow } from './SiteHistoryTable';

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
    sites: SiteHistoryRow[];
}

type AdminTab = 'users' | 'sites' | 'announcements';

export function AdminDashboard({ users, sites }: AdminDashboardProps) {
    const [activeTab, setActiveTab] = useState<AdminTab>('users');

    return (
        <PageShell maxWidth="7xl" padding="default">
            <div className="space-y-6">
                <PageHeader
                    title="Admin Dashboard"
                    description="Manage user access visibility, site history migration and system announcements."
                />

                <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as AdminTab)} className="space-y-6">
                    <TabsList>
                        <TabsTrigger value="users">Users</TabsTrigger>
                        <TabsTrigger value="sites">Sites</TabsTrigger>
                        <TabsTrigger value="announcements">System Announcements</TabsTrigger>
                    </TabsList>

                    <TabsContent value="users">
                        <SectionCard
                            title={`Users (${users.length})`}
                            bodyClassName="p-0"
                        >
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead scope="col" className="px-6">User</TableHead>
                                        <TableHead scope="col" className="px-6">Status</TableHead>
                                        <TableHead scope="col" className="px-6">Trmnl</TableHead>
                                        <TableHead scope="col" className="px-6">Sites</TableHead>
                                        <TableHead scope="col" className="px-6">Created</TableHead>
                                        <TableHead scope="col" className="px-6">Last Data</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {users.map((user) => (
                                        <TableRow key={user.id}>
                                            <TableCell className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm font-medium text-gray-900 dark:text-white">
                                                    {user.email || 'No Email'}
                                                </div>
                                                <div className="text-xs text-gray-500 dark:text-gray-400">
                                                    {user.id}
                                                </div>
                                            </TableCell>
                                            <TableCell className="px-6 py-4 whitespace-nowrap">
                                                <div className="flex flex-col gap-1">
                                                    <StatusPill status={user.is_active ? 'active' : 'inactive'} />
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
                                            </TableCell>
                                            <TableCell className="px-6 py-4 whitespace-nowrap">
                                                <StatusPill
                                                    status={user.has_trmnl_integration ? 'linked' : 'none'}
                                                    label={user.has_trmnl_integration ? 'Linked' : 'None'}
                                                />
                                            </TableCell>
                                            <TableCell className="px-6 py-4 whitespace-nowrap">
                                                <div className="flex flex-col gap-1">
                                                    {user.sites.length > 0 ? (
                                                        user.sites.map((site) => (
                                                            <Link
                                                                key={site.id}
                                                                href={`/site/${site.id}`}
                                                                className="text-xs font-medium text-primary hover:text-primary/80"
                                                            >
                                                                {site.name}
                                                            </Link>
                                                        ))
                                                    ) : (
                                                        <span className="text-xs text-gray-400 italic">No Sites</span>
                                                    )}
                                                </div>
                                            </TableCell>
                                            <TableCell className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                                {formatCreatedAt(user.created_at)}
                                            </TableCell>
                                            <TableCell className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                                {formatLastDataImport(user.last_data_import)}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </SectionCard>
                    </TabsContent>

                    <TabsContent value="sites">
                        <SectionCard
                            title={`Sites (${sites.length})`}
                            description="History migration status. Run the migrate command from cmd/next-app with a production DATABASE_URL; preview first, then add --apply."
                            bodyClassName="p-0"
                        >
                            <SiteHistoryTable sites={sites} />
                        </SectionCard>
                    </TabsContent>

                    <TabsContent value="announcements">
                        <SystemAnnouncementsManager />
                    </TabsContent>
                </Tabs>
            </div>
        </PageShell>
    );
}

function formatCreatedAt(value: AdminUser['created_at']): string {
    if (!value) return 'N/A';

    try {
        let date: Date;

        if (typeof value === 'number') {
            date = value < 4102444800
                ? new Date(value * 1000)
                : new Date(value);
        } else {
            date = new Date(value);
        }

        if (Number.isNaN(date.getTime())) {
            return 'Invalid';
        }

        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    } catch {
        return 'Error';
    }
}

function formatLastDataImport(value: AdminUser['last_data_import']): string {
    if (!value) return 'N/A';

    try {
        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return 'Invalid';
        }

        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    } catch {
        return 'Error';
    }
}
