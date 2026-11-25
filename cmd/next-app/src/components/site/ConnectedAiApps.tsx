'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import type { UserOAuthGrantSummary } from '@/lib/oauth/oauth-repo';

function formatShortDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ConnectedAiApps({ siteId }: { siteId: string }) {
    const [grants, setGrants] = useState<UserOAuthGrantSummary[] | null>(null);
    const [error, setError] = useState('');
    const [busyId, setBusyId] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        async function load() {
            try {
                const res = await fetch(`/api/oauth/grants?siteId=${encodeURIComponent(siteId)}`, {
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error();
                const data = (await res.json()) as { grants: UserOAuthGrantSummary[] };
                setGrants(data.grants);
            } catch {
                if (!controller.signal.aborted) {
                    setError('Couldn’t load connected AI apps.');
                }
            }
        }
        void load();
        return () => controller.abort();
    }, [siteId]);

    async function disconnect(grantId: string) {
        setBusyId(grantId);
        setError('');
        try {
            const res = await fetch(`/api/oauth/grants/${encodeURIComponent(grantId)}`, {
                method: 'DELETE',
            });
            if (!res.ok && res.status !== 404) throw new Error();
            setGrants(prev => prev?.filter(g => g.id !== grantId) ?? []);
        } catch {
            setError('Couldn’t disconnect this AI app.');
        } finally {
            setBusyId(null);
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Connected AI Apps</CardTitle>
                <CardDescription>
                    AI assistants you’ve authorized via OAuth 2.1 for read-only Powerwall access.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
                {grants === null && !error && (
                    <p className="text-sm text-muted-foreground">Loading connected apps…</p>
                )}
                {grants && grants.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                        No AI apps are connected to this home yet.
                    </p>
                )}
                {grants && grants.length > 0 && (
                    <ul className="divide-y divide-border">
                        {grants.map(grant => (
                            <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                                <div className="min-w-0 space-y-0.5">
                                    <p className="text-sm font-medium break-words">{grant.clientName}</p>
                                    <p className="text-xs text-muted-foreground break-words">
                                        {grant.publisherHost ? `App details from ${grant.publisherHost}` : 'Unverified app'}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        Connected {formatShortDate(grant.createdAt)}
                                        {grant.lastUsedAt ? ` · Last used ${formatShortDate(grant.lastUsedAt)}` : ' · Never used'}
                                        {grant.siteCount > 1 ? ` · Shared across ${grant.siteCount} homes` : ''}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    disabled={busyId === grant.id}
                                    aria-label={`Disconnect ${grant.clientName}`}
                                    onClick={() => void disconnect(grant.id)}
                                >
                                    Disconnect
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}
