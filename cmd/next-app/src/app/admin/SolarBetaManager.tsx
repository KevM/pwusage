'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SolarBetaSite } from '@/lib/solar-beta-admin-repo';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Form';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusPill } from '@/components/ui/StatusPill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** "E 106° · 24° · 4.9 kW" per plane, for a compact read of the detection. */
export function describePlanes(site: Pick<SolarBetaSite, 'planes' | 'acClipKw'>): string {
    if (site.planes.length === 0) return '—';
    const planes = site.planes.map((p) => {
        const point = COMPASS[Math.round((((p.azimuth % 360) + 360) % 360) / 45) % 8];
        return `${point} ${Math.round(p.azimuth)}° · ${Math.round(p.tilt)}° · ${p.dcKwp.toFixed(1)} kW`;
    });
    return site.acClipKw ? `${planes.join(' + ')} (clip ${site.acClipKw.toFixed(1)} kW)` : planes.join(' + ');
}

/** "from phone" or "estimated" under a stored location; null when no location is stored. */
export function describeLocationSource(site: Pick<SolarBetaSite, 'latitude' | 'locationSource'>): string | null {
    if (site.latitude === null) return null;
    return site.locationSource === 'device' ? 'from phone' : 'estimated';
}

async function send(method: 'POST' | 'PUT', body: unknown): Promise<string | null> {
    const res = await fetch('/api/admin/solar-beta', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error ?? `Request failed (${res.status})`;
}

function LocationEditor({ site, onSaved }: { site: SolarBetaSite; onSaved: () => void }) {
    const [latitude, setLatitude] = useState(site.latitude?.toString() ?? '');
    const [longitude, setLongitude] = useState(site.longitude?.toString() ?? '');
    const [error, setError] = useState<string | null>(null);

    async function save() {
        const error = await send('PUT', { siteId: site.siteId, latitude: Number(latitude), longitude: Number(longitude) });
        setError(error);
        if (!error) onSaved();
    }

    return (
        <div className="flex items-center gap-2">
            <Input aria-label="Latitude" className="w-24" value={latitude} onChange={(e) => setLatitude(e.target.value)} placeholder="lat" />
            <Input aria-label="Longitude" className="w-24" value={longitude} onChange={(e) => setLongitude(e.target.value)} placeholder="lon" />
            <Button size="sm" variant="outline" onClick={save} disabled={!latitude || !longitude}>Save</Button>
            {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
    );
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
        const error = await send('POST', body);
        setMessage(error ?? (enabled ? `Added ${trimmed}` : `Removed ${trimmed}`));
        if (!error) {
            setTarget('');
            refresh();
        }
    }

    return (
        <SectionCard
            title={`Solar forecast beta (${new Set(sites.map((s) => s.userId)).size} users)`}
            description="Grant the solar-forecast-beta role by email or site ID. Detection runs every 3 hours for beta sites with a location; seed one here to test before the iOS location step ships. Locations are stored rounded to 2 decimals."
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
                        <TableHead>Location</TableHead>
                        <TableHead>Detection</TableHead>
                        <TableHead>Layout</TableHead>
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
                                <LocationEditor key={`${site.latitude},${site.longitude},${site.locationSource}`} site={site} onSaved={refresh} />
                                {describeLocationSource(site) && (
                                    <div className="mt-1 text-xs text-gray-400">{describeLocationSource(site)}</div>
                                )}
                            </TableCell>
                            <TableCell className="text-sm">
                                <StatusPill status={site.status ?? 'needs location'} />
                                {site.confidence && <div className="text-xs text-gray-400">{site.confidence}{site.reasons.length ? ` · ${site.reasons.join(', ')}` : ''}</div>}
                                {site.detectedAt && <div className="text-xs text-gray-400">{new Date(site.detectedAt).toLocaleString()}</div>}
                            </TableCell>
                            <TableCell className="text-sm">{describePlanes(site)}</TableCell>
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
