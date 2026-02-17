'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { Breadcrumbs } from '@/components/Breadcrumbs';
import { TrmnlLivePreview } from '@/components/trmnl/TrmnlLivePreview';
import {
    buildDefaultTrmnlComponentScreens,
    DEFAULT_TRMNL_COMPONENT_CONFIG,
    MAX_TRMNL_COMPONENT_SCREENS,
    normalizeTrmnlComponentScreens,
    TrmnlComponentConfig,
    TrmnlComponentScreen
} from '@/lib/trmnl-component-config';

interface ScreenPreviewState {
    html: string;
    error: string;
    loading: boolean;
}

interface DropIndicator {
    screenId: string;
    position: 'before' | 'after';
}

function getScreenLabel(index: number): string {
    return `Screen ${index + 1}`;
}

function ManageContent() {
    const searchParams = useSearchParams();
    const uuid = searchParams.get('uuid');
    const token = searchParams.get('token') || searchParams.get('jwt');
    const pluginSettingIdParam = searchParams.get('plugin_setting_id') || searchParams.get('plugin_id');

    const [sites, setSites] = useState<{ id: string, name: string, utility: string }[]>([]);
    const [selectedSite, setSelectedSite] = useState('');
    const [pluginSettingId, setPluginSettingId] = useState<number | null>(null);
    const [componentScreens, setComponentScreens] = useState<TrmnlComponentScreen[]>(buildDefaultTrmnlComponentScreens());
    const [editingScreenId, setEditingScreenId] = useState<string>('screen-1');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [previewByScreen, setPreviewByScreen] = useState<Record<string, ScreenPreviewState>>({});
    const [previewScale, setPreviewScale] = useState<number>(0.5);
    const [draggingScreenId, setDraggingScreenId] = useState<string | null>(null);
    const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
    const [formOffsetPx, setFormOffsetPx] = useState(0);
    const [formMinHeightPx, setFormMinHeightPx] = useState(0);

    const rightRailRef = useRef<HTMLDivElement | null>(null);
    const formCardRef = useRef<HTMLDivElement | null>(null);
    const screenCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

    const editingScreen = useMemo(
        () => componentScreens.find((screen) => screen.id === editingScreenId) ?? componentScreens[0] ?? null,
        [componentScreens, editingScreenId]
    );

    const updateEditingConfig = (updater: (current: TrmnlComponentConfig) => TrmnlComponentConfig) => {
        if (!editingScreen) return;
        setComponentScreens((prev) => prev.map((screen) => {
            if (screen.id !== editingScreen.id) return screen;
            return {
                ...screen,
                componentConfig: updater(screen.componentConfig)
            };
        }));
    };

    useEffect(() => {
        if (!uuid) {
            setError('Missing UUID');
            setLoading(false);
            return;
        }

        if (!token) {
            console.warn('Missing Trmnl security token in URL');
        }

        const fetchData = async () => {
            let redirecting = false;
            try {
                const [sitesRes, installRes] = await Promise.all([
                    fetch('/api/sites'),
                    fetch(`/api/trmnl/manage?uuid=${uuid}&token=${encodeURIComponent(token || '')}`)
                ]);

                if (installRes.status === 401 || sitesRes.status === 401) {
                    redirecting = true;
                    const siteToken = token || searchParams.get('jwt') || searchParams.get('token');
                    const tokenParam = siteToken ? `&jwt=${encodeURIComponent(siteToken)}` : '';
                    const callbackUrl = encodeURIComponent(`/trmnl/manage?uuid=${uuid}${tokenParam}`);
                    window.location.href = `/login?callback=${callbackUrl}`;
                    return;
                }

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

                        const normalizedScreens = normalizeTrmnlComponentScreens(installData.component_screens ?? null);
                        setComponentScreens(normalizedScreens);
                        setEditingScreenId(normalizedScreens[0]?.id ?? 'screen-1');
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
            setPreviewByScreen({});
            return;
        }

        let active = true;
        const timer = setTimeout(async () => {
            setPreviewByScreen((prev) => {
                const loadingState: Record<string, ScreenPreviewState> = {};
                for (const screen of componentScreens) {
                    const existing = prev[screen.id];
                    loadingState[screen.id] = {
                        html: existing?.html ?? '',
                        error: '',
                        loading: true
                    };
                }
                return loadingState;
            });

            const results = await Promise.all(componentScreens.map(async (screen) => {
                try {
                    const params = new URLSearchParams({
                        site_id: selectedSite,
                        component_config: JSON.stringify(screen.componentConfig)
                    });
                    const res = await fetch(`/api/trmnl/markup?${params.toString()}`, { credentials: 'include' });
                    const data = await res.json();
                    if (!res.ok) {
                        return {
                            id: screen.id,
                            state: {
                                html: '',
                                error: typeof data?.error === 'string' ? data.error : 'Failed to load preview',
                                loading: false
                            } as ScreenPreviewState
                        };
                    }
                    return {
                        id: screen.id,
                        state: {
                            html: typeof data.markup === 'string' ? data.markup : '',
                            error: typeof data.markup === 'string' ? '' : 'Preview response missing markup',
                            loading: false
                        } as ScreenPreviewState
                    };
                } catch (err) {
                    return {
                        id: screen.id,
                        state: {
                            html: '',
                            error: (err as Error).message,
                            loading: false
                        } as ScreenPreviewState
                    };
                }
            }));

            if (!active) return;
            const nextState: Record<string, ScreenPreviewState> = {};
            for (const result of results) {
                nextState[result.id] = result.state;
            }
            setPreviewByScreen(nextState);
        }, 250);

        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [selectedSite, componentScreens]);

    useEffect(() => {
        const updateFormOffset = () => {
            if (typeof window !== 'undefined' && window.innerWidth < 1280) {
                setFormOffsetPx(0);
                setFormMinHeightPx(0);
                return;
            }

            const rail = rightRailRef.current;
            const form = formCardRef.current;
            const selectedId = editingScreen?.id;
            const selectedCard = selectedId ? screenCardRefs.current[selectedId] : null;
            if (!rail || !form || !selectedCard) {
                setFormOffsetPx(0);
                setFormMinHeightPx(0);
                return;
            }

            const railRect = rail.getBoundingClientRect();
            const cardRect = selectedCard.getBoundingClientRect();
            const desired = Math.max(0, cardRect.top - railRect.top);
            const maxOffset = Math.max(0, rail.clientHeight - form.offsetHeight);
            setFormOffsetPx(Math.min(desired, maxOffset));
            setFormMinHeightPx(Math.max(0, selectedCard.offsetHeight));
        };

        updateFormOffset();
        window.addEventListener('resize', updateFormOffset);
        return () => {
            window.removeEventListener('resize', updateFormOffset);
        };
    }, [editingScreen?.id, componentScreens, previewByScreen]);

    const handleAddScreen = () => {
        if (componentScreens.length >= MAX_TRMNL_COMPONENT_SCREENS) return;
        const nextIndex = componentScreens.length;
        const newScreen: TrmnlComponentScreen = {
            id: `screen-${Date.now()}`,
            name: getScreenLabel(nextIndex),
            componentConfig: { ...DEFAULT_TRMNL_COMPONENT_CONFIG }
        };
        setComponentScreens((prev) => [...prev, newScreen]);
        setEditingScreenId(newScreen.id);
        setSuccess('');
    };

    const handleDeleteScreen = (screenId: string) => {
        if (componentScreens.length <= 1) return;
        const screen = componentScreens.find((s) => s.id === screenId);
        if (!screen) return;
        const ok = window.confirm(`Delete ${screen.name}? This cannot be undone.`);
        if (!ok) return;

        const remaining = componentScreens.filter((s) => s.id !== screenId)
            .map((s, i) => ({ ...s, name: getScreenLabel(i) }));
        setComponentScreens(remaining);
        if (editingScreenId === screenId) {
            setEditingScreenId(remaining[0]?.id ?? 'screen-1');
        }
        setSuccess('');
    };

    const reorderScreens = (fromId: string, toId: string, position: 'before' | 'after') => {
        setComponentScreens((prev) => {
            const fromIndex = prev.findIndex((s) => s.id === fromId);
            const toIndex = prev.findIndex((s) => s.id === toId);
            if (fromIndex < 0 || toIndex < 0) return prev;

            let targetIndex = toIndex + (position === 'after' ? 1 : 0);
            if (fromIndex < targetIndex) targetIndex -= 1;
            if (targetIndex === fromIndex) return prev;

            const next = [...prev];
            const [moved] = next.splice(fromIndex, 1);
            const safeTarget = Math.max(0, Math.min(targetIndex, next.length));
            next.splice(safeTarget, 0, moved);
            return next;
        });
        setSuccess('');
    };

    const handleSave = async () => {
        if (!selectedSite || !uuid) return;

        setLoading(true);
        setSuccess('');
        setError('');

        try {
            const payloadScreens = componentScreens.map((screen, index) => ({
                ...screen,
                name: getScreenLabel(index)
            }));
            const res = await fetch('/api/trmnl/manage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uuid,
                    site_id: selectedSite,
                    token: token || null,
                    plugin_setting_id: pluginSettingId,
                    component_screens: payloadScreens
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

    const currentSite = sites.find((s) => s.id === selectedSite);

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

                <div className="mt-8 grid gap-6 xl:grid-cols-2">
                    <div className="xl:col-span-2 px-1 py-1">
                        <h1 className="text-3xl font-bold mb-3">Manage Trmnl Connection</h1>

                        {sites.length > 1 ? (
                            <div className="mb-6">
                                <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Select Site to Display</label>
                                <select
                                    value={selectedSite}
                                    onChange={(e) => setSelectedSite(e.target.value)}
                                    className="w-full p-2 border rounded dark:bg-slate-800 dark:border-slate-700"
                                >
                                    {sites.map((site) => (
                                        <option key={site.id} value={site.id}>{site.name}</option>
                                    ))}
                                </select>
                            </div>
                        ) : sites.length === 0 ? (
                            <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/30 rounded border border-yellow-200 dark:border-yellow-700">
                                <h3 className="font-semibold text-yellow-800 dark:text-yellow-200 mb-2">No Energy Sites Found</h3>
                                <p className="text-sm text-yellow-700 dark:text-yellow-300 mb-4">
                                    We couldn&apos;t find any compatible energy sites associated with your account.
                                </p>
                                <Link href="/" className="text-sm font-medium text-blue-600 hover:text-blue-500 underline">
                                    Return to Dashboard
                                </Link>
                            </div>
                        ) : null
                        }

                        {currentSite && (
                            <div className="p-4 bg-gray-50 dark:bg-slate-800 rounded-lg">
                                <p className="text-sm text-gray-700 dark:text-gray-200">
                                    Your site <span className="font-semibold">{currentSite.name}</span> serviced by the utility <span className="font-semibold">{currentSite.utility}</span> is being linked to your Trmnl device.
                                </p>
                            </div>
                        )}
                    </div>

                    <div className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="font-semibold text-gray-900 dark:text-white">Screen Configuration</h3>
                            <div className="flex items-center gap-2">
                                <label className="text-xs text-gray-600 dark:text-gray-300">Preview size</label>
                                <select
                                    value={String(previewScale)}
                                    onChange={(e) => setPreviewScale(Number.parseFloat(e.target.value))}
                                    className="text-xs p-1 border rounded dark:bg-slate-800 dark:border-slate-700"
                                >
                                    <option value="0.25">25%</option>
                                    <option value="0.33">33%</option>
                                    <option value="0.5">50%</option>
                                    <option value="0.75">75%</option>
                                    <option value="1">100%</option>
                                </select>
                                <button
                                    type="button"
                                    onClick={handleAddScreen}
                                    disabled={componentScreens.length >= MAX_TRMNL_COMPONENT_SCREENS}
                                    className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-700 disabled:opacity-50 inline-flex items-center gap-1"
                                    aria-label="Add screen"
                                    title="Add screen"
                                >
                                    <span aria-hidden="true">+</span>
                                    <span>Add Screen</span>
                                </button>
                            </div>
                        </div>
                        <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
                            Each request rotates to the next screen. Edit a screen to change its component set.
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                            Tip: drag the handle to reorder screen rotation.
                        </p>

                        <div className="space-y-4">
                            {componentScreens.map((screen, index) => {
                                const preview = previewByScreen[screen.id] ?? { html: '', error: '', loading: false };
                                const isEditing = editingScreen?.id === screen.id;
                                const isDragging = draggingScreenId === screen.id;
                                const isDropBefore = dropIndicator?.screenId === screen.id && dropIndicator.position === 'before' && !isDragging;
                                const isDropAfter = dropIndicator?.screenId === screen.id && dropIndicator.position === 'after' && !isDragging;
                                return (
                                    <div
                                        key={screen.id}
                                        ref={(el) => {
                                            screenCardRefs.current[screen.id] = el;
                                        }}
                                    >
                                        {isDropBefore && (
                                            <div className="h-1.5 rounded bg-blue-500/80 mb-2 animate-pulse" />
                                        )}
                                        <div
                                            onClick={() => setEditingScreenId(screen.id)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    setEditingScreenId(screen.id);
                                                }
                                            }}
                                            role="button"
                                            tabIndex={0}
                                            onDragOver={(e) => {
                                                e.preventDefault();
                                                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                                                const pointerY = e.clientY;
                                                const midpoint = rect.top + rect.height / 2;
                                                setDropIndicator({
                                                    screenId: screen.id,
                                                    position: pointerY < midpoint ? 'before' : 'after'
                                                });
                                            }}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                const fromId = e.dataTransfer.getData('text/plain') || draggingScreenId;
                                                const position = dropIndicator?.screenId === screen.id ? dropIndicator.position : 'before';
                                                if (fromId) reorderScreens(fromId, screen.id, position);
                                                setDraggingScreenId(null);
                                                setDropIndicator(null);
                                            }}
                                            className={`rounded border p-3 cursor-pointer transition-all duration-150 ${isEditing ? 'border-2 border-zinc-700 dark:border-zinc-200 shadow-lg bg-white dark:bg-slate-900' : 'border-gray-200 dark:border-slate-700'} ${isDragging ? 'opacity-60 scale-[0.99]' : (isEditing ? 'scale-100 hover:shadow-xl' : 'scale-100 hover:shadow-sm')}`}
                                        >
                                            <div className="mb-2 flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <span
                                                        draggable
                                                        onDragStart={(e) => {
                                                            e.stopPropagation();
                                                            e.dataTransfer.effectAllowed = 'move';
                                                            e.dataTransfer.setData('text/plain', screen.id);
                                                            setDraggingScreenId(screen.id);
                                                        }}
                                                        onDragEnd={() => {
                                                            setDraggingScreenId(null);
                                                            setDropIndicator(null);
                                                        }}
                                                        onClick={(e) => e.stopPropagation()}
                                                        title="Drag to reorder screens"
                                                        aria-label="Drag to reorder screens"
                                                        className={`inline-flex items-center justify-center w-5 h-5 rounded border border-gray-300 dark:border-slate-700 text-xs text-gray-600 dark:text-gray-300 transition-transform duration-150 ${isDragging ? 'cursor-grabbing scale-110' : 'cursor-grab hover:scale-110'}`}
                                                    >
                                                        ⋮⋮
                                                    </span>
                                                    <span className="text-sm font-semibold">{getScreenLabel(index)}</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setEditingScreenId(screen.id);
                                                        }}
                                                        className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-700"
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDeleteScreen(screen.id);
                                                        }}
                                                        disabled={componentScreens.length <= 1}
                                                        className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 disabled:opacity-50 inline-flex items-center justify-center"
                                                        aria-label={`Delete ${screen.name}`}
                                                        title={`Delete ${screen.name}`}
                                                    >
                                                        <span aria-hidden="true">🗑</span>
                                                    </button>
                                                </div>
                                            </div>

                                            <div className={isEditing ? 'rounded-md p-2 bg-zinc-200 dark:bg-zinc-800' : ''}>
                                                <TrmnlLivePreview
                                                    previewHtml={preview.html}
                                                    previewError={preview.error}
                                                    previewLoading={preview.loading}
                                                    hasSource={Boolean(selectedSite)}
                                                    maxDisplayScale={1}
                                                    showScaleControls={false}
                                                    displayScaleOverride={previewScale}
                                                />
                                            </div>
                                        </div>
                                        {isDropAfter && (
                                            <div className="h-1.5 rounded bg-blue-500/80 mt-2 animate-pulse" />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div ref={rightRailRef} className="relative min-h-[240px]">
                        <div
                            ref={formCardRef}
                            className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800 transition-transform duration-300"
                            style={{
                                transform: `translateY(${formOffsetPx}px)`,
                                minHeight: formMinHeightPx > 0 ? `${formMinHeightPx}px` : undefined
                            }}
                        >
                            <h2 className="text-xl font-semibold mb-2">Screen Components</h2>
                            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                                Editing: <span className="font-semibold">{editingScreen ? editingScreen.name : 'Screen 1'}</span>
                            </p>

                            {success && <div className="mb-4 p-2 bg-green-100 text-green-700 rounded">{success}</div>}

                            <div className="mb-6 p-4 bg-gray-50 dark:bg-slate-800 rounded-lg">
                                <h3 className="font-semibold mb-3 text-gray-900 dark:text-white">Components</h3>
                                <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                                    Choose what renders on this screen.
                                </p>

                                <div className="space-y-4">
                                    <div className="space-y-2">
                                        <label className="block text-xs text-gray-500 dark:text-gray-400">Live stats</label>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                            <label className="flex items-center gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={editingScreen?.componentConfig.showLiveGrid ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showLiveGrid: e.target.checked }))}
                                                />
                                                <span>Grid</span>
                                            </label>
                                            <label className="flex items-center gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={editingScreen?.componentConfig.showLiveSolar ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showLiveSolar: e.target.checked }))}
                                                />
                                                <span>Solar</span>
                                            </label>
                                            <label className="flex items-center gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={editingScreen?.componentConfig.showLiveBattery ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showLiveBattery: e.target.checked }))}
                                                />
                                                <span>Battery</span>
                                            </label>
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <label className="block text-xs text-gray-500 dark:text-gray-400">Charts and Tables</label>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                            <label className="flex items-center gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={editingScreen?.componentConfig.showEnergyChart ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showEnergyChart: e.target.checked }))}
                                                />
                                                <span>Energy Usage Chart</span>
                                            </label>
                                            <div className="space-y-1">
                                                <label className="flex items-center gap-2 text-sm">
                                                    <input
                                                        type="checkbox"
                                                        checked={editingScreen?.componentConfig.showBatterySoc ?? false}
                                                        onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showBatterySoc: e.target.checked }))}
                                                    />
                                                    <span>Battery Level</span>
                                                </label>
                                                <select
                                                    value={editingScreen?.componentConfig.batterySocMode ?? 'glyph'}
                                                    onChange={(e) => updateEditingConfig((prev) => ({
                                                        ...prev,
                                                        batterySocMode: e.target.value === 'chart' ? 'chart' : 'glyph'
                                                    }))}
                                                    className="w-full p-1.5 border rounded dark:bg-slate-800 dark:border-slate-700 text-xs"
                                                >
                                                    <option value="glyph">Glyph</option>
                                                    <option value="chart">Chart</option>
                                                </select>
                                            </div>
                                            <label className="flex items-center gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={editingScreen?.componentConfig.showEstimatedBill ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showEstimatedBill: e.target.checked }))}
                                                />
                                                <span>Estimated Monthly Bill</span>
                                            </label>
                                        </div>
                                    </div>
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
