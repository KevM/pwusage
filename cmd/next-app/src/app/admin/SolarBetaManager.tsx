'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SolarBetaSite } from '@/lib/solar-beta-admin-repo';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Form';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusPill } from '@/components/ui/StatusPill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';

async function send(body: unknown): Promise<string | null> {
    const res = await fetch('/api/admin/solar-beta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error ?? `Request failed (${res.status})`;
}

export function SolarBetaManager() {
    const [sites, setSites] = useState<SolarBetaSite[]>([]);
    const [target, setTarget] = useState('');
    const [message, setMessage] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

    useEffect(() => {
        fetch('/api/admin/solar-beta')
            .then((res) => (res.ok ? res.json() : { sites: [] }))
            .then((data) => setSites(data.sites ?? []))
            .catch(() => setSites([]));
    }, [refreshKey]);

    async function setBeta(value: string, enabled: boolean) {
        const trimmed = value.trim();
        const body = trimmed.includes('@') ? { email: trimmed, enabled } : { siteId: trimmed, enabled };
        const error = await send(body);
        setMessage(error ?? (enabled ? `Added ${trimmed}` : `Removed ${trimmed}`));
        if (!error) {
            setTarget('');
            refresh();
        }
    }

    return (
        <SectionCard
            title={`Solar forecast beta (${new Set(sites.map((s) => s.userId)).size} users)`}
            description="Grant the solar-forecast-beta role by email or site ID. The app detects each site's panel layout on the phone; the home location and layout stay on the user's devices and their private iCloud, so they are not shown here."
            bodyClassName="p-0"
        >
            <form
                className="flex flex-wrap items-end gap-2 p-4"
                onSubmit={(e) => { e.preventDefault(); void setBeta(target, true); }}
            >
                <div className="flex flex-col gap-1">
                    <Label htmlFor="solar-beta-target">Email or site ID</Label>
                    <Input id="solar-beta-target" className="w-72" value={target} onChange={(e) => setTarget(e.target.value)} />
                </div>
                <Button type="submit" size="sm" disabled={!target.trim()}>Add to beta</Button>
                {message && <span className="text-sm text-gray-500 dark:text-gray-400">{message}</span>}
            </form>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Site</TableHead>
                        <TableHead />
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {sites.map((site) => (
                        <TableRow key={site.siteId}>
                            <TableCell className="text-sm">
                                {site.email ?? site.userId}
                                {site.authStatus && site.authStatus !== 'active' && (
                                    <StatusPill className="ml-2" status={site.authStatus} />
                                )}
                            </TableCell>
                            <TableCell className="text-sm">{site.siteName}<div className="text-xs text-gray-400">{site.siteId}</div></TableCell>
                            <TableCell>
                                <Button size="sm" variant="secondary" onClick={() => void setBeta(site.siteId, false)}>Remove user</Button>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </SectionCard>
    );
}
