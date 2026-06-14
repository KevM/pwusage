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

    return (
        <PageShell maxWidth="7xl" padding="default">
            <div className="space-y-6">
                <PageHeader
                    title="Admin Dashboard"
                    description="Manage user access visibility and publish system announcements."
                />

                <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'users' | 'announcements')} className="space-y-6">
                    <TabsList>
                        <TabsTrigger value="users">Users</TabsTrigger>
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
                                                        user.sites.map((site) => {
                                                            const s = site as typeof site & {
                                                                backfill_status?: string | null; backfill_days_done?: number | null; backfill_days_total?: number | null;
                                                                backfill_cursor?: string | null; backfill_oldest?: string | null; backfill_newest?: string | null;
                                                                backfill_error?: string | null; backfill_updated?: string | null;
                                                            };
                                                            const pct = s.backfill_days_total ? Math.round((s.backfill_days_done! / s.backfill_days_total) * 100) : 0;
                                                            const label = !s.backfill_status ? 'Not indexed'
                                                                : s.backfill_status === 'pending' ? 'Queued'
                                                                : s.backfill_status === 'running' ? `Indexing ${pct}%`
                                                                : s.backfill_status === 'complete' ? 'Indexed' : 'Error';
                                                            const tone = !s.backfill_status ? 'bg-gray-100 text-gray-500 dark:bg-slate-800'
                                                                : s.backfill_status === 'complete' ? 'bg-green-100 text-green-700 dark:bg-green-950/40'
                                                                : s.backfill_status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-950/40'
                                                                : 'bg-blue-100 text-blue-700 dark:bg-blue-950/40';
                                                            const title = s.backfill_status
                                                                ? `status=${s.backfill_status} ${pct}% (${s.backfill_days_done}/${s.backfill_days_total})\n`
                                                                  + `cursor ${s.backfill_cursor}  range ${s.backfill_oldest}→${s.backfill_newest}\n`
                                                                  + `updated ${s.backfill_updated ?? ''}${s.backfill_error ? `\nerror: ${s.backfill_error}` : ''}`
                                                                : 'No history indexing for this site';
                                                            return (
                                                                <div key={site.id} className="flex items-center gap-2">
                                                                    <Link href={`/site/${site.id}`} className="text-xs font-medium text-primary hover:text-primary/80">{site.name}</Link>
                                                                    <span title={title} className={`text-[10px] px-1.5 py-0.5 rounded font-medium select-none ${tone}`}>{label}</span>
                                                                </div>
                                                            );
                                                        })
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
