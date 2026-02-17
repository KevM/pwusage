'use client';

import { useEffect, useState } from 'react';
import { BillingStartDayForm } from '@/components/BillingStartDayForm';
import { TimezoneDisplayForm } from '@/components/TimezoneDisplayForm';
import { TariffList } from './TariffList';
import { TrmnlLivePreview } from '@/components/trmnl/TrmnlLivePreview';


import { SiteWithTariffs, TrmnlInstallation } from '@/lib/db';

interface SettingsViewProps {
    site: SiteWithTariffs;
    // TrmnlInstallation can be undefined if not found
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
    const [previewHtml, setPreviewHtml] = useState('');
    const [previewError, setPreviewError] = useState('');
    const [previewLoading, setPreviewLoading] = useState(true);
    const pluginSettingId = extractPluginSettingId(installation);

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
        <div className="w-full max-w-5xl mx-auto">
            <h1 className="text-3xl font-bold mb-8">Site Settings</h1>

            <div className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800">
                <h2 className="text-xl font-semibold mb-6">Billing Configuration</h2>

                <div className="mb-6">
                    <BillingStartDayForm siteId={site.id} initialDay={site.billing_start_day || 1} />
                    <p className="text-xs text-gray-500 mt-1">
                        Calculates monthly usage starting from this day.
                    </p>
                </div>
                <div className="pt-4 border-t border-gray-200 dark:border-gray-800">
                    <TimezoneDisplayForm siteId={site.id} initialMode={site.timezone_display_mode || 'SITE'} />
                </div>
            </div>


            <div className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800 mt-8">
                <h2 className="text-xl font-semibold mb-4">Trmnl E-Ink Display</h2>
                <p className="mb-6 text-gray-600 dark:text-gray-300">
                    Display your daily energy usage on a dedicated, always-on e-ink screen.
                </p>

                <div className="mb-8">
                    <TrmnlLivePreview
                        previewHtml={previewHtml}
                        previewError={previewError}
                        previewLoading={previewLoading}
                        hasSource={true}
                    />
                </div>

                <div className="flex gap-4 flex-col sm:flex-row">
                    {installation ? (
                        <a
                            href={pluginSettingId
                                ? `https://trmnl.com/plugin_settings/${pluginSettingId}/edit`
                                : 'https://trmnl.com/dashboard'}
                            target="_blank"
                            className="flex-1 bg-gray-800 text-white px-4 py-2 rounded text-center hover:bg-gray-700 transition-colors font-semibold"
                        >
                            Manage Trmnl Plugin
                        </a>
                    ) : (
                        <a
                            href="https://trmnl.com/plugin_settings/new?keyname=powerwall_energy_usage"
                            target="_blank"
                            className="flex-1 bg-black text-white px-4 py-2 rounded text-center hover:bg-gray-800 transition-colors font-semibold"
                        >
                            Add Trmnl Plugin
                        </a>
                    )}
                    <a
                        href="https://trmnl.com"
                        target="_blank"
                        className="flex-1 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-200 px-4 py-2 rounded text-center hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                    >
                        Buy Device
                    </a>
                </div>
            </div>

            <div className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800 mt-8">
                <h2 className="text-xl font-semibold mb-4">Tariff Information</h2>
                <div className="mb-6">
                    <TariffList tariffs={site.tariffs} />
                </div>
            </div>
        </div>
    );
}
