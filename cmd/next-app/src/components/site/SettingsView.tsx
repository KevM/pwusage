'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { BillingStartDayForm } from '@/components/BillingStartDayForm';
import { TimezoneDisplayForm } from '@/components/TimezoneDisplayForm';
import { TariffList } from './TariffList';
import { TrmnlLivePreview } from '@/components/trmnl/TrmnlLivePreview';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Select, Label } from '@/components/ui/Form';
import { H2 } from '@/components/ui/Typography';
import { Button } from '@/components/ui/Button';


import { SiteWithTariffs, TrmnlInstallation } from '@/lib/db';

interface SettingsViewProps {
    site: SiteWithTariffs;
    installation: TrmnlInstallation | undefined;
}

function parseInstallationJson(value: unknown): Record<string, unknown> | null {
    if (!value) return null;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
            return null;
        } catch {
            return null;
        }
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }

    return null;
}

function coercePositiveInt(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return null;
}

function extractPluginSettingId(installation: TrmnlInstallation | undefined): number | null {
    if (!installation) return null;
    if (installation.plugin_setting_id) return installation.plugin_setting_id;

    const json = parseInstallationJson(installation.json);
    if (!json) return null;

    const topLevel = coercePositiveInt(json.plugin_setting_id);
    if (topLevel) return topLevel;

    const user = json.user;
    if (user && typeof user === 'object' && !Array.isArray(user)) {
        const nested = coercePositiveInt((user as Record<string, unknown>).plugin_setting_id);
        if (nested) return nested;
    }

    const callbackUrl = typeof json.installation_callback_url === 'string' ? json.installation_callback_url : null;
    if (callbackUrl) {
        const match = callbackUrl.match(/\/plugin_settings\/(\d+)/);
        if (match) {
            return coercePositiveInt(match[1]);
        }
    }

    return null;
}

export function SettingsView({ site, installation }: SettingsViewProps) {
    const router = useRouter();
    const [previewHtml, setPreviewHtml] = useState('');
    const [previewError, setPreviewError] = useState('');
    const [previewLoading, setPreviewLoading] = useState(true);
    const [previewScale, setPreviewScale] = useState<number>(0.5);
    const [refreshLoading, setRefreshLoading] = useState(false);
    const [refreshStatus, setRefreshStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
    const pluginSettingId = extractPluginSettingId(installation);

    // Generate deep link QR code on mount
    useEffect(() => {
        const deepLink = `${window.location.origin}/site/${site.id}/live?action=park`;
        QRCode.toDataURL(deepLink, { width: 256, margin: 2 })
            .then(url => setQrCodeUrl(url))
            .catch(err => console.error('Error generating QR code:', err));
    }, [site.id]);

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
                    message: data.error || 'Failed to refresh tariffs'
                });
                return;
            }

            setRefreshStatus({
                type: 'success',
                message: 'Tariffs updated successfully'
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
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Battery Hold Quick Link (QR)</CardTitle>
                    <CardDescription>
                        Scan this QR code with your phone or mobile device to jump directly to the Live view and initiate a battery hold command.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col items-center">
                    <div className="bg-white p-3 rounded-lg border border-gray-100 dark:border-gray-800 shadow-sm mb-4">
                        {qrCodeUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={qrCodeUrl} alt="Battery Hold Deep Link QR Code" className="w-48 h-48" />
                        ) : (
                            <div className="w-48 h-48 flex items-center justify-center text-sm text-gray-400">
                                Generating...
                            </div>
                        )}
                    </div>
                    <div className="flex gap-4 w-full max-w-sm">
                        <Button
                            variant="outline"
                            className="w-full"
                            onClick={() => {
                                const deepLink = `${window.location.origin}/site/${site.id}/live?action=park`;
                                navigator.clipboard.writeText(deepLink)
                                    .then(() => alert('Deep link URL copied to clipboard!'))
                                    .catch(() => alert('Failed to copy link.'));
                            }}
                        >
                            Copy Deep Link
                        </Button>
                    </div>
                </CardContent>
            </Card>


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

                    <div className="flex gap-4 flex-col sm:flex-row">
                        {installation ? (
                            <a
                                href={pluginSettingId
                                    ? `https://trmnl.com/plugin_settings/${pluginSettingId}/edit`
                                    : 'https://trmnl.com/dashboard'}
                                target="_blank"
                                rel="noreferrer"
                                className="flex-1"
                            >
                                <Button className="w-full" size="lg">Manage Trmnl Plugin</Button>
                            </a>
                        ) : (
                            <a
                                href="https://trmnl.com/plugin_settings/new?keyname=powerwall_energy_usage"
                                target="_blank"
                                rel="noreferrer"
                                className="flex-1"
                            >
                                <Button className="w-full" size="lg">Add Trmnl Plugin</Button>
                            </a>
                        )}
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
                    <CardTitle>Tariff Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div>
                        <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
                            The rates shown below are synced from your Powerwall settings in the Tesla App. If you&apos;ve recently changed your Time-of-Use (TOU) rates or tariff settings in Tesla, click the button below to refresh.
                        </p>
                        <Button
                            onClick={handleRefreshTariffs}
                            disabled={refreshLoading}
                            className="gap-2"
                        >
                            {refreshLoading ? (
                                <>
                                    <span className="inline-block animate-spin">⟳</span>
                                    Refreshing...
                                </>
                            ) : (
                                'Refresh Tariffs from Tesla'
                            )}
                        </Button>
                    </div>

                    {refreshStatus && (
                        <div className={`p-3 rounded-md text-sm ${
                            refreshStatus.type === 'success'
                                ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200'
                                : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
                        }`}>
                            {refreshStatus.message}
                        </div>
                    )}
                </CardContent>
            </Card>

            <TariffList tariffs={site.tariffs} />
        </div>
    );
}
