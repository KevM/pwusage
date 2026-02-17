'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { Breadcrumbs } from '@/components/Breadcrumbs';
import { TrmnlLivePreview } from '@/components/trmnl/TrmnlLivePreview';
import {
    DEFAULT_TRMNL_COMPONENT_CONFIG,
    TrmnlComponentConfig,
    normalizeTrmnlComponentConfig
} from '@/lib/trmnl-component-config';

function ManageContent() {
    const searchParams = useSearchParams();
    const uuid = searchParams.get('uuid');
    // Support both 'token' and 'jwt' param names for future proofing
    const token = searchParams.get('token') || searchParams.get('jwt');
    const pluginSettingIdParam = searchParams.get('plugin_setting_id') || searchParams.get('plugin_id');

    const [sites, setSites] = useState<{ id: string, name: string, utility: string }[]>([]);
    const [selectedSite, setSelectedSite] = useState('');
    const [pluginSettingId, setPluginSettingId] = useState<number | null>(null);
    const [componentConfig, setComponentConfig] = useState<TrmnlComponentConfig>(DEFAULT_TRMNL_COMPONENT_CONFIG);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [previewHtml, setPreviewHtml] = useState('');
    const [previewError, setPreviewError] = useState('');
    const [previewLoading, setPreviewLoading] = useState(false);

    useEffect(() => {
        if (!uuid) {
            setError('Missing UUID');
            setLoading(false);
            return;
        }

        if (!token) {
            // Warn user but allow proceed (might be viewing only?) - backend will block saves
            // Actually, let's allow viewing existing config without token if logged in?
            // Current API GET /manage doesn't check token. 
            // Saving requires token.
            console.warn('Missing Trmnl security token in URL');
        }

        // Fetch sites and current installation
        const fetchData = async () => {
            let redirecting = false;
            try {
                const [sitesRes, installRes] = await Promise.all([
                    fetch('/api/sites'),
                    fetch(`/api/trmnl/manage?uuid=${uuid}&token=${encodeURIComponent(token || '')}`)
                ]);

                // Check if user is unauthorized for either the installation or the sites list
                if (installRes.status === 401 || sitesRes.status === 401) {
                    redirecting = true;
                    // Preserve token in callback. Check both jwt and token source
                    const siteToken = token || searchParams.get('jwt') || searchParams.get('token');
                    const tokenParam = siteToken ? `&jwt=${encodeURIComponent(siteToken)}` : '';
                    const callbackUrl = encodeURIComponent(`/trmnl/manage?uuid=${uuid}${tokenParam}`);
                    window.location.href = `/login?callback=${callbackUrl}`;
                    return;
                }

                // If installRes is OK, we can show something. 
                // If sitesRes is 401, we just can't show the sites list.

                let sitesData: { id: string, name: string, utility: string }[] = [];
                if (sitesRes.ok) {
                    sitesData = await sitesRes.json();
                    setSites(sitesData);
                }

                if (installRes.ok) {
                    const installData = await installRes.json();
                    if (installData) {
                        if (installData.site_id) setSelectedSite(installData.site_id);
                        if (installData.plugin_setting_id) setPluginSettingId(installData.plugin_setting_id);
                        setComponentConfig(normalizeTrmnlComponentConfig(installData.component_config));
                    }
                    if ((!installData || !installData.plugin_setting_id) && pluginSettingIdParam) {
                        const parsed = Number.parseInt(pluginSettingIdParam, 10);
                        if (Number.isInteger(parsed) && parsed > 0) {
                            setPluginSettingId(parsed);
                        }
                    }
                    if ((!installData || !installData.site_id) && sitesData.length > 0) {
                        setSelectedSite(sitesData[0].id);
                    }
                } else if (sitesData.length > 0) {
                    // If install fetch fails but we have sites, just default to first site
                    setSelectedSite(sitesData[0].id);
                }
            } catch {
                setError('Failed to load data');
            } finally {
                if (!redirecting) setLoading(false);
            }
        };

        fetchData();
    }, [uuid, token, searchParams, pluginSettingIdParam]);

    useEffect(() => {
        if (!selectedSite) {
            setPreviewHtml('');
            setPreviewError('');
            return;
        }

        let active = true;
        const timer = setTimeout(async () => {
            setPreviewLoading(true);
            setPreviewError('');

            try {
                const params = new URLSearchParams({
                    site_id: selectedSite,
                    component_config: JSON.stringify(componentConfig)
                });
                const res = await fetch(`/api/trmnl/markup?${params.toString()}`, {
                    credentials: 'include'
                });
                const data = await res.json();
                if (!active) return;

                if (!res.ok) {
                    const message = typeof data?.error === 'string' ? data.error : 'Failed to load preview';
                    setPreviewError(message);
                    setPreviewHtml('');
                    return;
                }

                if (typeof data.markup === 'string' && data.markup.length > 0) {
                    setPreviewHtml(data.markup);
                } else {
                    setPreviewError('Preview response missing markup');
                    setPreviewHtml('');
                }
            } catch (err) {
                if (!active) return;
                setPreviewError((err as Error).message);
                setPreviewHtml('');
            } finally {
                if (active) setPreviewLoading(false);
            }
        }, 250);

        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [selectedSite, componentConfig]);

    const handleSave = async () => {
        if (!selectedSite || !uuid) return;

        // Relaxed check: We allow missing token if user is authenticated (backend will verify)
        // if (!token) { ... } -> Removed

        setLoading(true);
        setSuccess('');
        setError('');

        try {
            const res = await fetch('/api/trmnl/manage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uuid,
                    site_id: selectedSite,
                    token: token || null, // Pass null if missing
                    plugin_setting_id: pluginSettingId,
                    component_config: componentConfig
                })
            });

            if (!res.ok) {
                const text = await res.text();
                try {
                    const json = JSON.parse(text);
                    throw new Error(json.error || text);
                } catch {
                    throw new Error(text);
                }
            }
            setSuccess('Settings saved!');
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    if (loading) return <div className="p-8">Loading...</div>;
    if (error) return <div className="p-8 text-red-500">Error: {error}</div>;

    const currentSite = sites.find(s => s.id === selectedSite);

    return (
        <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-16 lg:pt-2 lg:pb-6">
            <div className="w-full max-w-[1800px]">
                {currentSite && (
                    <Breadcrumbs items={[
                        { label: 'Manage' },
                        { label: currentSite.name, href: `/site/${currentSite.id}` },
                        { label: 'Settings', href: `/site/${currentSite.id}/settings` },
                        { label: 'Trmnl Connect' }
                    ]} />
                )}
                {!currentSite && (
                    <Breadcrumbs items={[
                        { label: 'Manage' },
                        { label: 'Trmnl Connect' }
                    ]} />
                )}

                <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
                    <div className="order-1 xl:order-2 xl:sticky xl:top-3 h-fit bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800">
                        <h3 className="font-semibold mb-2 text-gray-900 dark:text-white">Live Preview</h3>
                        <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
                            Preview updates automatically as you toggle components. It uses current site data and your unsaved settings.
                        </p>
                        <TrmnlLivePreview
                            previewHtml={previewHtml}
                            previewError={previewError}
                            previewLoading={previewLoading}
                            hasSource={Boolean(selectedSite)}
                        />
                    </div>

                    <div className="order-2 xl:order-1 space-y-6">
                        <div className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800">
                            <h1 className="text-2xl font-bold mb-6">Manage Trmnl Connection</h1>

                            {sites.length > 1 ? (
                                <div className="mb-6">
                                    <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Select Site to Display</label>
                                    <select
                                        value={selectedSite}
                                        onChange={e => setSelectedSite(e.target.value)}
                                        className="w-full p-2 border rounded dark:bg-slate-800 dark:border-slate-700"
                                    >
                                        {sites.map(site => (
                                            <option key={site.id} value={site.id}>{site.name}</option>
                                        ))}
                                    </select>
                                </div>
                            ) : sites.length === 1 ? (
                                <div className="mb-6">
                                    <p className="text-sm font-medium mb-1 text-gray-500">Link to Site:</p>
                                    <p className="font-bold text-lg">{sites[0].name}</p>
                                    <input type="hidden" value={sites[0].id} />
                                </div>
                            ) : (
                                <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/30 rounded border border-yellow-200 dark:border-yellow-700">
                                    <h3 className="font-semibold text-yellow-800 dark:text-yellow-200 mb-2">No Energy Sites Found</h3>
                                    <p className="text-sm text-yellow-700 dark:text-yellow-300 mb-4">
                                        We couldn&apos;t find any compatible energy sites associated with your account.
                                    </p>
                                    <Link href="/" className="text-sm font-medium text-blue-600 hover:text-blue-500 underline">
                                        Return to Dashboard
                                    </Link>
                                </div>
                            )}

                            {currentSite && (
                                <div className="p-4 bg-gray-50 dark:bg-slate-800 rounded-lg">
                                    <h3 className="font-semibold mb-2 text-gray-900 dark:text-white">Selected Site Details</h3>
                                    <div className="grid grid-cols-2 gap-4 text-sm">
                                        <div>
                                            <span className="block text-gray-500 dark:text-gray-400">Site Name</span>
                                            <span className="font-medium">{currentSite.name}</span>
                                        </div>
                                        <div>
                                            <span className="block text-gray-500 dark:text-gray-400">Utility Provider</span>
                                            <span className="font-medium">{currentSite.utility}</span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800">
                            <h2 className="text-xl font-semibold mb-6">Markup Components</h2>

                            {success && <div className="mb-4 p-2 bg-green-100 text-green-700 rounded">{success}</div>}

                            <div className="mb-8 p-4 bg-gray-50 dark:bg-slate-800 rounded-lg">
                                <h3 className="font-semibold mb-3 text-gray-900 dark:text-white">Markup Components</h3>
                                <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                                    Choose what renders on your TRMNL device.
                                </p>

                                <div className="space-y-3">
                                    <div className="space-y-2">
                                        <label className="block text-xs text-gray-500 dark:text-gray-400">Live stats components</label>
                                        <label className="flex items-center gap-3 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={componentConfig.showLiveGrid}
                                                onChange={e => setComponentConfig(prev => ({ ...prev, showLiveGrid: e.target.checked }))}
                                            />
                                            <span>Live grid usage</span>
                                        </label>
                                        <label className="flex items-center gap-3 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={componentConfig.showLiveSolar}
                                                onChange={e => setComponentConfig(prev => ({ ...prev, showLiveSolar: e.target.checked }))}
                                            />
                                            <span>Live solar production</span>
                                        </label>
                                        <label className="flex items-center gap-3 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={componentConfig.showLiveBattery}
                                                onChange={e => setComponentConfig(prev => ({ ...prev, showLiveBattery: e.target.checked }))}
                                            />
                                            <span>Live battery status</span>
                                        </label>
                                    </div>

                                    <label className="flex items-center gap-3 text-sm">
                                        <input
                                            type="checkbox"
                                            checked={componentConfig.showEnergyChart}
                                            onChange={e => setComponentConfig(prev => ({ ...prev, showEnergyChart: e.target.checked }))}
                                        />
                                        <span>Energy usage chart</span>
                                    </label>

                                    <div className="space-y-2">
                                        <label className="flex items-center gap-3 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={componentConfig.showBatterySoc}
                                                onChange={e => setComponentConfig(prev => ({ ...prev, showBatterySoc: e.target.checked }))}
                                            />
                                            <span>Battery SoC component</span>
                                        </label>
                                        <div className="pl-6">
                                            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">SoC style</label>
                                            <select
                                                value={componentConfig.batterySocMode}
                                                onChange={e => setComponentConfig(prev => ({
                                                    ...prev,
                                                    batterySocMode: e.target.value === 'chart' ? 'chart' : 'glyph'
                                                }))}
                                                className="w-full p-2 border rounded dark:bg-slate-800 dark:border-slate-700 text-sm"
                                            >
                                                <option value="glyph">Glyphs / inline indicators</option>
                                                <option value="chart">Chart</option>
                                            </select>
                                        </div>
                                    </div>

                                    <label className="flex items-center gap-3 text-sm">
                                        <input
                                            type="checkbox"
                                            checked={componentConfig.showEstimatedBill}
                                            onChange={e => setComponentConfig(prev => ({ ...prev, showEstimatedBill: e.target.checked }))}
                                        />
                                        <span>Estimated energy bill</span>
                                    </label>
                                </div>
                            </div>

                            <button
                                onClick={handleSave}
                                disabled={!selectedSite}
                                className="w-full bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
                            >
                                Save Changes
                            </button>
                        </div>
                    </div>
                </div>

                <div className="mt-4 text-center">
                    {pluginSettingId && (
                        <a
                            href={`https://trmnl.com/plugin_settings/${pluginSettingId}/edit?force_refresh=true`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                        >
                            Back to Trmnl
                        </a>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function Page() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <ManageContent />
        </Suspense>
    );
}
