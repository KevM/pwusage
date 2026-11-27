'use client';

import { useEffect, useState } from 'react';
import { TrmnlLivePreview } from '@/components/trmnl/TrmnlLivePreview';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Select, Label } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import type { TrmnlInstallation } from '@/lib/db';
import { toTrmnlDevices } from '@/lib/trmnl-devices';

function formatDeviceDate(value: string | null): string {
    if (!value) return '';
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function TrmnlSettings({ siteId, installations }: {
    siteId: string;
    installations: TrmnlInstallation[];
}) {
    const [previewHtml, setPreviewHtml] = useState('');
    const [previewError, setPreviewError] = useState('');
    const [previewLoading, setPreviewLoading] = useState(true);
    const [previewScale, setPreviewScale] = useState<number>(0.5);
    const devices = toTrmnlDevices(installations);

    useEffect(() => {
        let active = true;

        const fetchPreview = async () => {
            setPreviewLoading(true);
            setPreviewError('');
            setPreviewHtml('');

            try {
                const res = await fetch(`/api/trmnl/markup?site_id=${siteId}`, {
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
    }, [siteId]);

    return (
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
    );
}
