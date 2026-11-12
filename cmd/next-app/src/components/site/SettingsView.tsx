'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { drawQrWithLogo } from '@/lib/qr-generator';
import { continueUrl } from '@/app/continue/continue-logic';
import { BillingStartDayForm } from '@/components/BillingStartDayForm';
import { TimezoneDisplayForm } from '@/components/TimezoneDisplayForm';
import { SankeyRendererForm } from '@/components/SankeyRendererForm';
import { DEFAULT_RENDERER_ID } from '@/lib/sankey/renderers/registry';
import { TariffList } from './TariffList';
import { TrmnlLivePreview } from '@/components/trmnl/TrmnlLivePreview';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Select, Label } from '@/components/ui/Form';
import { H2 } from '@/components/ui/Typography';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';


import { SiteWithTariffs, TrmnlInstallation } from '@/lib/db';
import type { SiteTariffsTimelineResponse } from '@/lib/tariff-contract';
import { toTrmnlDevices } from '@/lib/trmnl-devices';

interface SettingsViewProps {
    site: SiteWithTariffs;
    installations: TrmnlInstallation[];
    memberEmails: string[];
    tariffTimeline?: SiteTariffsTimelineResponse | null;
}

function formatDeviceDate(value: string | null): string {
    if (!value) return '';
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function SettingsView({ site, installations, memberEmails, tariffTimeline = null }: SettingsViewProps) {
    const router = useRouter();
    const { toast } = useToast();
    const [timelineOverride, setTimelineOverride] = useState<SiteTariffsTimelineResponse | null>(null);
    const timeline = timelineOverride ?? tariffTimeline;
    const [previewHtml, setPreviewHtml] = useState('');
    const [previewError, setPreviewError] = useState('');
    const [previewLoading, setPreviewLoading] = useState(true);
    const [previewScale, setPreviewScale] = useState<number>(0.5);
    const [refreshLoading, setRefreshLoading] = useState(false);
    const [retryLoading, setRetryLoading] = useState(false);
    const [refreshStatus, setRefreshStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const devices = toTrmnlDevices(installations);

    // Callback ref to render QR code with centered logo as soon as canvas mounts
    const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
        if (canvas) {
            const deepLink = continueUrl(window.location.origin, `/site/${site.id}/live?action=park`);
            drawQrWithLogo(canvas, deepLink)
                .catch(err => console.error('Error generating Battery Saver QR code:', err));
        }
    }, [site.id]);

    useEffect(() => {
        const status = timeline?.reattribution?.status;
        if (status !== 'pending' && status !== 'running') return;
        const timer = setInterval(async () => {
            try {
                const res = await fetch(`/api/site/${site.id}/tariffs`, { credentials: 'include' });
                if (res.ok) {
                    const next = (await res.json()) as SiteTariffsTimelineResponse;
                    setTimelineOverride(next);
                }
            } catch {
                // Keep polling silently while re-attribution is active
            }
        }, 3000);
        return () => clearInterval(timer);
    }, [site.id, timeline?.reattribution?.status]);

    const handleRefreshTariffs = async () => {
        setRefreshLoading(true);
        setRefreshStatus(null);
        try {
            const response = await fetch(`/api/site/${site.id}/refresh-tariffs`, {
                method: 'POST',
                credentials: 'include'
            });
            const data = await response.json();

            if (!response.ok) {
                setRefreshStatus({
                    type: 'error',
                    message: data.error || 'Couldn’t refresh your rate plan. Try again.'
                });
                return;
            }

            if (data.timeline) {
                setTimelineOverride(data.timeline as SiteTariffsTimelineResponse);
            }
            setRefreshStatus({
                type: 'success',
                message: data.updatedFromTesla ? 'Rate plan updated' : 'Rate plan is up to date'
            });

            router.refresh();
        } catch (error) {
            setRefreshStatus({
                type: 'error',
                message: error instanceof Error ? error.message : 'An error occurred'
            });
        } finally {
            setRefreshLoading(false);
        }
    };

    const handleRetryReattribution = async () => {
        setRetryLoading(true);
        try {
            const response = await fetch(`/api/site/${site.id}/tariffs/reattribute`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (response.ok) {
                const data = (await response.json()) as SiteTariffsTimelineResponse;
                setTimelineOverride(data);
                router.refresh();
            }
        } finally {
            setRetryLoading(false);
        }
    };

    useEffect(() => {
        let active = true;

        const fetchPreview = async () => {
            setPreviewLoading(true);
            setPreviewError('');
            setPreviewHtml('');

            try {
                const res = await fetch(`/api/trmnl/markup?site_id=${site.id}`, {
                    credentials: 'include'
                });
                const data = await res.json();
                if (!active) return;

                if (!res.ok) {
                    const message = typeof data?.error === 'string' ? data.error : 'Failed to load preview';
                    setPreviewError(message);
                    return;
                }

                if (typeof data.markup === 'string' && data.markup.length > 0) {
                    setPreviewHtml(data.markup);
                } else {
                    setPreviewError('Preview response missing markup');
                }
            } catch (err) {
                if (!active) return;
                setPreviewError((err as Error).message);
            } finally {
                if (active) setPreviewLoading(false);
            }
        };

        fetchPreview();

        return () => {
            active = false;
        };
    }, [site.id]);

    return (
        <div className="w-full max-w-5xl mx-auto space-y-8">
            <H2 className="mb-8">Site Settings</H2>

            <Card>
                <CardHeader>
                    <CardTitle>Billing Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div>
                        <BillingStartDayForm siteId={site.id} initialDay={site.billing_start_day || 1} />
                        <p className="text-xs text-gray-500 mt-1">
                            Calculates monthly usage starting from this day.
                        </p>
                    </div>
                    <div className="pt-2">
                        <TimezoneDisplayForm siteId={site.id} initialMode={site.timezone_display_mode || 'SITE'} />
                    </div>
                    <div className="pt-2">
                        <SankeyRendererForm
                            siteId={site.id}
                            initialRenderer={site.sankey_renderer || DEFAULT_RENDERER_ID}
                            options={[{ id: 'direct', label: 'Direct (multi-color)' }]}
                        />
                    </div>
                </CardContent>
            </Card>

            {memberEmails.length > 1 ? (
                <Card>
                    <CardHeader>
                        <CardTitle>People with Access</CardTitle>
                        <CardDescription>
                            Tesla manages access to this Powerwall. Everyone listed can view this site’s shared history and settings.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ul className="space-y-2" aria-label="People with access">
                            {memberEmails.map(email => (
                                <li key={email} className="text-sm text-gray-700 dark:text-gray-200">{email}</li>
                            ))}
                        </ul>
                    </CardContent>
                </Card>
            ) : null}

            <Card>
                <CardHeader
                    action={
                        <div className="flex items-center gap-3 bg-white dark:bg-slate-900">
                            <Label className="whitespace-nowrap">Preview size</Label>
                            <div className="w-24">
                                <Select
                                    value={String(previewScale)}
                                    onChange={(e) => setPreviewScale(Number.parseFloat(e.target.value))}
                                    className="h-8 py-1 text-xs m-0"
                                    style={{ width: '100%' }}
                                >
                                    <option value="0.25">25%</option>
                                    <option value="0.33">33%</option>
                                    <option value="0.5">50%</option>
                                    <option value="0.75">75%</option>
                                    <option value="1">100%</option>
                                </Select>
                            </div>
                        </div>
                    }
                >
                    <CardTitle>Trmnl E-Ink Display</CardTitle>
                    <CardDescription>
                        Display your daily energy usage on a dedicated, always-on e-ink screen.
                    </CardDescription>
                </CardHeader>

                <CardContent>
                    <div className="mb-8">
                        <TrmnlLivePreview
                            previewHtml={previewHtml}
                            previewError={previewError}
                            previewLoading={previewLoading}
                            hasSource={true}
                            maxDisplayScale={1}
                            showScaleControls={false}
                            displayScaleOverride={previewScale}
                        />
                    </div>

                    {devices.length > 0 ? (
                        <ul className="mb-4 divide-y divide-gray-200 dark:divide-slate-800 rounded-lg border border-gray-200 dark:border-slate-800" aria-label="Connected Trmnl devices">
                            {devices.map(device => (
                                <li key={device.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <p className="font-medium text-gray-900 dark:text-white">Device {device.uuid.slice(0, 8)}</p>
                                        <p className="text-xs text-gray-500">Connected {formatDeviceDate(device.connectedAt)}</p>
                                    </div>
                                    <div className="flex gap-2">
                                        <a href={`/trmnl/manage?uuid=${encodeURIComponent(device.uuid)}`}>
                                            <Button renderAs="span" variant="outline" size="sm">Screens</Button>
                                        </a>
                                        <a
                                            href={`https://trmnl.com/plugin_settings/${device.pluginSettingId}/edit`}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            <Button renderAs="span" size="sm">Open in Trmnl</Button>
                                        </a>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : null}

                    <div className="flex gap-4 flex-col sm:flex-row">
                        <a
                            href="https://trmnl.com/plugin_settings/new?keyname=powerwall_energy_usage"
                            target="_blank"
                            rel="noreferrer"
                            className="flex-1"
                        >
                            <Button className="w-full" size="lg">
                                {devices.length > 0 ? 'Add another device' : 'Add Trmnl Plugin'}
                            </Button>
                        </a>
                        <a
                            href="https://trmnl.com"
                            target="_blank"
                            rel="noreferrer"
                            className="flex-1"
                        >
                            <Button className="w-full" size="lg" variant="outline">Buy Device</Button>
                        </a>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Battery Saver Quick Link (QR)</CardTitle>
                    <CardDescription>
                        Saves your Powerwall charge for when rates spike. Scan this QR code with your phone to open the Live view and turn on Battery Saver.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col items-center">
                    <div className="bg-white p-3 rounded-lg border border-gray-100 dark:border-gray-800 shadow-sm mb-4">
                        <canvas ref={canvasRef} className="w-48 h-48" />
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-sm mb-4 italic">
                        Put this QR code near your EV charger so you can turn on Battery Saver from your phone before charging the car.
                    </p>
                    <div className="flex gap-4 w-full max-w-sm">
                        <Button
                            variant="outline"
                            className="w-full"
                            onClick={() => {
                                const deepLink = continueUrl(window.location.origin, `/site/${site.id}/live?action=park`);
                                navigator.clipboard.writeText(deepLink)
                                    .then(() => toast({ title: 'Link copied', description: 'Battery Saver link copied to the clipboard.', variant: 'success' }))
                                    .catch(() => toast({ title: 'Copy failed', description: 'Failed to copy link.', variant: 'danger' }));
                            }}
                        >
                            Copy Link
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <TariffList
                timeline={timeline}
                onRefresh={handleRefreshTariffs}
                refreshLoading={refreshLoading}
                refreshStatus={refreshStatus}
                onRetryReattribution={handleRetryReattribution}
                retryLoading={retryLoading}
            />
        </div>
    );
}

