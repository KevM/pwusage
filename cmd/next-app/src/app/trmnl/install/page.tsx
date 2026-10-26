'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { PageBreadcrumbs } from '@/components/PageBreadcrumbs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/Alert';
import { ErrorPanel, LoadingPanel } from '@/components/ui/AsyncState';
import { Button } from '@/components/ui/Button';
import { Select, Label } from '@/components/ui/Form';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';

function InstallContent() {
    const searchParams = useSearchParams();
    const code = searchParams.get('code');
    const installationCallbackUrl = searchParams.get('installation_callback_url');

    // detailed_install_url has the uuid in it usually, but we also look for uuid or installation_uuid
    let installationUuid = searchParams.get('installation_uuid') || searchParams.get('uuid');

    // Fallback: extract from callback URL if present
    if (!installationUuid && installationCallbackUrl) {
        const match = installationCallbackUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (match) {
            installationUuid = match[0];
        }
    }

    const [sites, setSites] = useState<{ id: string, name: string }[]>([]);
    const [selectedSite, setSelectedSite] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [autoConnecting, setAutoConnecting] = useState(false);

    const performSetup = async (
        siteId: string,
        authCode: string,
        callbackUrl: string | null,
        uuid: string | null,
        pluginSettingId: string | null = null,
    ) => {
        try {
            const res = await fetch('/api/trmnl/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    code: authCode,
                    site_id: siteId,
                    uuid,
                    plugin_setting_id: pluginSettingId,
                }),
            });

            if (!res.ok) throw new Error(await res.text());

            // Redirect back to Trmnl
            if (callbackUrl) {
                window.location.href = callbackUrl;
            } else {
                alert('Setup complete! You can close this window.');
            }
        } catch (err) {
            setError((err as Error).message);
            setLoading(false);
            setAutoConnecting(false);
        }
    };

    // Effect to handle initial data load and auto-connection
    useEffect(() => {
        if (!code) return; // Wait for code

        let redirecting = false;

        // 1. Fetch sites
        fetch('/api/sites', { credentials: 'include' })
            .then(async res => {
                if (res.status === 401) {
                    redirecting = true;
                    // Construct callback URL with all current parameters
                    const currentSearch = window.location.search;
                    const callbackUrl = encodeURIComponent(`/trmnl/install${currentSearch}`);
                    // OAuth starts in a route handler; use document navigation to avoid RSC retries.
                    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                    window.location.assign(`/login?callback=${callbackUrl}`);
                    return null;
                }
                return res.json();
            })
            .then(data => {
                if (!data) return; // Handled redirect or error

                setSites(data);
                if (data.length > 0) {
                    const firstSiteId = data[0].id;
                    setSelectedSite(firstSiteId);

                    // Auto-connect if only one site
                    if (data.length === 1) {
                        setAutoConnecting(true);
                        // Extract plugin ID here too for auto-connect
                        let pluginSettingId: string | null = null;
                        if (installationCallbackUrl) {
                            const match = installationCallbackUrl.match(/\/plugin_settings\/(\d+)/);
                            if (match) pluginSettingId = match[1];
                        }
                        void performSetup(firstSiteId, code, installationCallbackUrl, installationUuid, pluginSettingId);
                    } else if (!redirecting) {
                        setLoading(false);
                    }
                } else if (!redirecting) {
                    setLoading(false);
                }
            })
            .catch(() => {
                setError('Failed to load sites');
                setLoading(false);
            });
    }, [code, installationCallbackUrl, installationUuid]); // Only run once on mount (with code)

    const handleSetup = () => {
        // Extract plugin_setting_id from callback URL if possible for robust linking
        let pluginSettingId: string | null = null;
        if (installationCallbackUrl) {
            const match = installationCallbackUrl.match(/\/plugin_settings\/(\d+)/);
            if (match) {
                pluginSettingId = match[1];
            }
        }
        void performSetup(selectedSite, code!, installationCallbackUrl, installationUuid, pluginSettingId);
    };

    if (loading || autoConnecting) {
        return (
            <PageShell maxWidth="md" className="pt-10">
                <LoadingPanel
                    title="Connecting to Trmnl..."
                    description={autoConnecting && sites.length > 0 ? `Linking to ${sites[0].name}` : undefined}
                />
            </PageShell>
        );
    }

    if (error) {
        return (
            <PageShell maxWidth="md" className="pt-10">
                <ErrorPanel title="Error" message={error} />
            </PageShell>
        );
    }

    return (
        <PageShell maxWidth="2xl" className="space-y-6">
            <PageBreadcrumbs items={[
                { label: 'Install' },
            ]} />

            <PageHeader title="Connect to Trmnl" titleTag="h1" density="compact" />

            <SectionCard>
                {sites.length > 1 ? (
                    <div className="mb-6 space-y-2">
                        <Label htmlFor="trmnl-site-select">Select Site to Display</Label>
                        <Select
                            id="trmnl-site-select"
                            value={selectedSite}
                            onChange={(e) => setSelectedSite(e.target.value)}
                        >
                            {sites.map((site) => (
                                <option key={site.id} value={site.id}>{site.name}</option>
                            ))}
                        </Select>
                    </div>
                ) : sites.length === 1 ? (
                    <div className="mb-6">
                        <p className="mb-1 text-sm font-medium text-gray-500">Link to Site:</p>
                        <p className="text-lg font-bold text-gray-900 dark:text-white">{sites[0].name}</p>
                    </div>
                ) : (
                    <div className="mb-6">
                        <Alert variant="warning">
                            <AlertTitle>No Energy Sites Found</AlertTitle>
                            <AlertDescription>
                                We couldn&apos;t find any compatible energy sites associated with your account.
                            </AlertDescription>
                        </Alert>
                    </div>
                )}

                <div className="flex flex-col gap-4 sm:flex-row">
                    <Button
                        onClick={handleSetup}
                        disabled={!selectedSite || !code}
                        className="flex-1"
                    >
                        Connect
                    </Button>

                    <a
                        href="https://trmnl.com/plugin_settings/new?keyname=powerwall_energy_usage"
                        target="_blank"
                        rel="noreferrer"
                        className="flex-1"
                    >
                        <Button renderAs="span" variant="secondary" className="w-full">
                            Back to Trmnl
                        </Button>
                    </a>
                </div>
            </SectionCard>
        </PageShell>
    );
}

export default function Page() {
    return (
        <Suspense fallback={(
            <PageShell maxWidth="md" className="pt-10">
                <LoadingPanel title="Loading..." />
            </PageShell>
        )}>
            <InstallContent />
        </Suspense>
    );
}
