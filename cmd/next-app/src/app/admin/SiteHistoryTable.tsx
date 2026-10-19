'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { StatusPill } from '@/components/ui/StatusPill';

type DateLike = Date | string;

/** One row of SiteRepo.getHistoryOverview, as it arrives at the client. */
export interface SiteHistoryRow {
    id: string;
    name: string;
    timezone: string;
    installed: DateLike;
    owner_email: string | null;
    history_backfill_from: DateLike | null;
    history_migrated_at: DateLike | null;
    archived_days: number;
    first_archived_day: DateLike | null;
    last_archived_day: DateLike | null;
}

export function siteHistoryStatus(site: SiteHistoryRow): { status: string; label: string } {
    if (site.history_migrated_at) return { status: 'complete', label: 'Migrated' };
    if (site.archived_days > 0) return { status: 'pending', label: 'Partial' };
    return { status: 'default', label: 'Not migrated' };
}

export function migrateCommand(siteId: string): string {
    return `npx tsx scripts/migrate-site-history.ts --site-id ${siteId}`;
}

/** Local `YYYY-MM-DD` in the site's timezone. */
function siteDate(value: DateLike, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(value));
}

function CopyButton({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className="text-xs font-medium text-primary hover:text-primary/80"
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                } catch {
                    // Clipboard blocked; the text is still selectable.
                }
            }}
        >
            {copied ? 'Copied' : label}
        </button>
    );
}

export function SiteHistoryTable({ sites }: { sites: SiteHistoryRow[] }) {
    return (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead scope="col" className="px-6">Site</TableHead>
                    <TableHead scope="col" className="px-6">History</TableHead>
                    <TableHead scope="col" className="px-6">Archive</TableHead>
                    <TableHead scope="col" className="px-6">Migrate</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {sites.map((site) => {
                    const status = siteHistoryStatus(site);
                    const command = migrateCommand(site.id);
                    return (
                        <TableRow key={site.id}>
                            <TableCell className="px-6 py-4 whitespace-nowrap">
                                <Link href={`/site/${site.id}`} className="text-sm font-medium text-primary hover:text-primary/80">
                                    {site.name}
                                </Link>
                                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                                    <span className="font-mono select-all">{site.id}</span>
                                    <CopyButton text={site.id} label="Copy" />
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400">{site.owner_email ?? 'No owner'}</div>
                            </TableCell>
                            <TableCell className="px-6 py-4 whitespace-nowrap">
                                <div className="flex flex-col gap-1">
                                    <StatusPill status={status.status} label={status.label} />
                                    {site.history_migrated_at && (
                                        <span className="text-[10px] text-gray-400">
                                            {siteDate(site.history_migrated_at, site.timezone)}
                                        </span>
                                    )}
                                    <span className="text-xs text-gray-500 dark:text-gray-400">
                                        Installed {siteDate(site.installed, site.timezone)}
                                    </span>
                                    {site.history_backfill_from && (
                                        <span className="text-xs text-gray-500 dark:text-gray-400">
                                            Data from {siteDate(site.history_backfill_from, site.timezone)}
                                        </span>
                                    )}
                                </div>
                            </TableCell>
                            <TableCell className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                {site.archived_days > 0 && site.first_archived_day && site.last_archived_day ? (
                                    <div className="flex flex-col gap-1">
                                        <span>{site.archived_days.toLocaleString('en-US')} days</span>
                                        <span className="text-xs">
                                            {siteDate(site.first_archived_day, site.timezone)} → {siteDate(site.last_archived_day, site.timezone)}
                                        </span>
                                    </div>
                                ) : (
                                    <span className="text-xs text-gray-400 italic">None</span>
                                )}
                            </TableCell>
                            <TableCell className="px-6 py-4">
                                <div className="flex items-center gap-2">
                                    <code className="text-[11px] text-gray-500 dark:text-gray-400 select-all break-all">{command}</code>
                                    <CopyButton text={command} label="Copy" />
                                </div>
                            </TableCell>
                        </TableRow>
                    );
                })}
            </TableBody>
        </Table>
    );
}
