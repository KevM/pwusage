'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { PageBreadcrumbs } from '@/components/PageBreadcrumbs';
import { TrmnlLivePreview } from '@/components/trmnl/TrmnlLivePreview';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/Alert';
import { ErrorPanel, LoadingPanel } from '@/components/ui/AsyncState';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox, Label, Select } from '@/components/ui/Form';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
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
    const [loading, setLoading] = useState<boolean>(Boolean(uuid));
    const [error, setError] = useState<string>(uuid ? '' : 'Missing UUID');
    const [success, setSuccess] = useState('');
    const [previewByScreen, setPreviewByScreen] = useState<Record<string, ScreenPreviewState>>({});
    const [previewScale, setPreviewScale] = useState<number>(0.5);
    const [draggingScreenId, setDraggingScreenId] = useState<string | null>(null);
    const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
    const [formOffsetPx, setFormOffsetPx] = useState(0);
    const [formHeightPx, setFormHeightPx] = useState(0);

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
        if (!uuid) return;

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
        if (!selectedSite) return;

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
                setFormHeightPx(0);
                return;
            }

            const rail = rightRailRef.current;
            const form = formCardRef.current;
            const selectedId = editingScreen?.id;
            const selectedCard = selectedId ? screenCardRefs.current[selectedId] : null;
            if (!rail || !form || !selectedCard) {
                setFormOffsetPx(0);
                setFormHeightPx(0);
                return;
            }

            const railRect = rail.getBoundingClientRect();
            const cardRect = selectedCard.getBoundingClientRect();
            const desired = Math.max(0, cardRect.top - railRect.top);
            const maxOffset = Math.max(0, rail.clientHeight - form.offsetHeight);
            setFormOffsetPx(Math.min(desired, maxOffset));
            setFormHeightPx(Math.max(0, selectedCard.offsetHeight));
        };

        updateFormOffset();
        window.addEventListener('resize', updateFormOffset);
        return () => {
            window.removeEventListener('resize', updateFormOffset);
        };
    }, [editingScreen?.id, componentScreens, previewByScreen, previewScale]);

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

    if (loading) {
        return (
            <PageShell maxWidth="7xl" className="px-4 py-6 md:px-8 lg:px-16">
                <LoadingPanel
                    title="Loading Trmnl connection"
                    description="Fetching your linked site and saved screen configuration."
                />
            </PageShell>
        );
    }
    if (error) {
        return (
            <PageShell maxWidth="7xl" className="px-4 py-6 md:px-8 lg:px-16">
                <ErrorPanel title="Failed to load Trmnl connection" message={error} />
            </PageShell>
        );
    }

    const currentSite = sites.find((s) => s.id === selectedSite);

    return (
        <PageShell
            maxWidth="full"
            padding="none"
            className="max-w-[1800px] px-4 pt-2 pb-6 md:px-8 lg:px-16"
        >
                {currentSite && (
                    <PageBreadcrumbs items={[
                        { label: 'Manage' },
                        { label: currentSite.name, href: `/site/${currentSite.id}` },
                        { label: 'Settings', href: `/site/${currentSite.id}/settings` },
                        { label: 'Trmnl Connect' }
                    ]} />
                )}
                {!currentSite && (
                    <PageBreadcrumbs items={[
                        { label: 'Manage' },
                        { label: 'Trmnl Connect' }
                    ]} />
                )}

                <PageHeader
                    className="mt-6"
                    title="Manage Trmnl Connection"
                    description="Configure rotating TRMNL screens, preview each layout, and save changes without interrupting the current link."
                    density="compact"
                />

                <div className="mt-8 grid gap-6 xl:grid-cols-2 min-w-0">
                    <SectionCard className="xl:col-span-2 min-w-0" title="Connection Details" density="compact">
                        {sites.length > 1 ? (
                            <div className="mb-6 space-y-2">
                                <Label htmlFor="trmnl-manage-site-select">Select Site to Display</Label>
                                <Select
                                    id="trmnl-manage-site-select"
                                    value={selectedSite}
                                    onChange={(e) => setSelectedSite(e.target.value)}
                                >
                                    {sites.map((site) => (
                                        <option key={site.id} value={site.id}>{site.name}</option>
                                    ))}
                                </Select>
                            </div>
                        ) : sites.length === 0 ? (
                            <Alert variant="warning" className="mb-6">
                                <AlertTitle>No Energy Sites Found</AlertTitle>
                                <AlertDescription className="mb-3">
                                    We couldn&apos;t find any compatible energy sites associated with your account.
                                </AlertDescription>
                                <Link href="/" className="text-sm font-medium underline">
                                    Return to Dashboard
                                </Link>
                            </Alert>
                        ) : null
                        }

                        {currentSite && (
                            <Alert variant="info">
                                <AlertDescription className="text-sm">
                                    Your site <span className="font-semibold">{currentSite.name}</span> serviced by the utility <span className="font-semibold">{currentSite.utility}</span> is being linked to your Trmnl device.
                                </AlertDescription>
                            </Alert>
                        )}
                    </SectionCard>

                    <SectionCard
                        title="Screen Configuration"
                        description="Each request rotates to the next screen. Edit a screen to change its component set."
                        className="min-w-0"
                        action={(
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                <Label htmlFor="trmnl-preview-size" className="text-xs">Preview size</Label>
                                <Select
                                    id="trmnl-preview-size"
                                    value={String(previewScale)}
                                    onChange={(e) => setPreviewScale(Number.parseFloat(e.target.value))}
                                    className="h-8 w-auto min-w-20 px-2 py-1 text-xs"
                                >
                                    <option value="0.25">25%</option>
                                    <option value="0.33">33%</option>
                                    <option value="0.5">50%</option>
                                    <option value="0.75">75%</option>
                                    <option value="1">100%</option>
                                </Select>
                                <Button
                                    type="button"
                                    onClick={handleAddScreen}
                                    disabled={componentScreens.length >= MAX_TRMNL_COMPONENT_SCREENS}
                                    variant="outline"
                                    size="sm"
                                    className="inline-flex gap-1"
                                    aria-label="Add screen"
                                    title="Add screen"
                                >
                                    <span aria-hidden="true">+</span>
                                    <span>Add Screen</span>
                                </Button>
                            </div>
                        )}
                    >
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
                                        className="min-w-0"
                                    >
                                        {isDropBefore && (
                                            <div className="h-1.5 rounded bg-blue-500/80 mb-2 animate-pulse" />
                                        )}
                                        <Card
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
                                            className={`cursor-pointer p-3 transition-all duration-150 min-w-0 ${isEditing ? 'border-2 border-zinc-700 dark:border-zinc-200 shadow-lg' : ''} ${isDragging ? 'scale-[0.99] opacity-60' : (isEditing ? 'scale-100 hover:shadow-xl' : 'scale-100 hover:shadow-sm')}`}
                                        >
                                            <div className="mb-2 flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-2 min-w-0">
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
                                                        className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded border border-gray-300 dark:border-slate-700 text-xs text-gray-600 dark:text-gray-300 transition-transform duration-150 ${isDragging ? 'cursor-grabbing scale-110' : 'cursor-grab hover:scale-110'}`}
                                                    >
                                                        ⋮⋮
                                                    </span>
                                                    <span className="text-sm font-semibold truncate">{getScreenLabel(index)}</span>
                                                </div>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    <Button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setEditingScreenId(screen.id);
                                                        }}
                                                        variant="outline"
                                                        size="sm"
                                                    >
                                                        Edit
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDeleteScreen(screen.id);
                                                        }}
                                                        disabled={componentScreens.length <= 1}
                                                        variant="outline"
                                                        size="sm"
                                                        className="border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20"
                                                        aria-label={`Delete ${screen.name}`}
                                                        title={`Delete ${screen.name}`}
                                                    >
                                                        <span aria-hidden="true">🗑</span>
                                                    </Button>
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
                                        </Card>
                                        {isDropAfter && (
                                            <div className="h-1.5 rounded bg-blue-500/80 mt-2 animate-pulse" />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </SectionCard>

                    <div ref={rightRailRef} className="relative min-h-[240px] min-w-0">
                        <Card
                            ref={formCardRef}
                            className="overflow-y-auto transition-transform duration-300 min-w-0"
                            style={{
                                transform: `translateY(${formOffsetPx}px)`,
                                height: formHeightPx > 0 ? `${formHeightPx}px` : undefined
                            }}
                        >
                            <CardHeader>
                                <CardTitle>Screen Components</CardTitle>
                                <p className="text-sm text-gray-600 dark:text-gray-300">
                                    Editing: <span className="font-semibold">{editingScreen ? editingScreen.name : 'Screen 1'}</span>
                                </p>
                            </CardHeader>
                            <CardBody className="space-y-6">
                                {success ? (
                                    <Alert variant="success">
                                        <AlertDescription>{success}</AlertDescription>
                                    </Alert>
                                ) : null}

                                <SectionCard
                                    density="compact"
                                    title="Components"
                                    description="Choose what renders on this screen."
                                    className="bg-gray-50/60 dark:bg-slate-800/60 min-w-0"
                                >

                                <div className="space-y-4">
                                    <div className="space-y-2">
                                        <Label className="block text-xs text-gray-500 dark:text-gray-400">Live stats</Label>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3 gap-3">
                                            <Label className="flex items-start gap-2 text-sm font-normal text-gray-700 dark:text-gray-200 cursor-pointer">
                                                <Checkbox
                                                    className="mt-0.5"
                                                    checked={editingScreen?.componentConfig.showLiveGrid ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showLiveGrid: e.target.checked }))}
                                                />
                                                <span>Grid</span>
                                            </Label>
                                            <Label className="flex items-start gap-2 text-sm font-normal text-gray-700 dark:text-gray-200 cursor-pointer">
                                                <Checkbox
                                                    className="mt-0.5"
                                                    checked={editingScreen?.componentConfig.showLiveSolar ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showLiveSolar: e.target.checked }))}
                                                />
                                                <span>Solar</span>
                                            </Label>
                                            <Label className="flex items-start gap-2 text-sm font-normal text-gray-700 dark:text-gray-200 cursor-pointer">
                                                <Checkbox
                                                    className="mt-0.5"
                                                    checked={editingScreen?.componentConfig.showLiveBattery ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showLiveBattery: e.target.checked }))}
                                                />
                                                <span>Battery</span>
                                            </Label>
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <Label className="block text-xs text-gray-500 dark:text-gray-400">Charts and Tables</Label>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3 gap-x-3 gap-y-4">
                                            <Label className="flex items-start gap-2 text-sm font-normal text-gray-700 dark:text-gray-200 cursor-pointer">
                                                <Checkbox
                                                    className="mt-0.5"
                                                    checked={editingScreen?.componentConfig.showEnergyChart ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showEnergyChart: e.target.checked }))}
                                                />
                                                <span className="leading-tight">Energy Usage Chart</span>
                                            </Label>
                                            <div className="space-y-1.5">
                                                <Label className="flex items-start gap-2 text-sm font-normal text-gray-700 dark:text-gray-200 cursor-pointer">
                                                    <Checkbox
                                                        className="mt-0.5"
                                                        checked={editingScreen?.componentConfig.showBatterySoc ?? false}
                                                        onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showBatterySoc: e.target.checked }))}
                                                    />
                                                    <span className="leading-tight">Battery Level</span>
                                                </Label>
                                                <div className="pl-6">
                                                    <Select
                                                        value={editingScreen?.componentConfig.batterySocMode ?? 'glyph'}
                                                        onChange={(e) => updateEditingConfig((prev) => ({
                                                            ...prev,
                                                            batterySocMode: e.target.value === 'chart' ? 'chart' : 'glyph'
                                                        }))}
                                                        className="h-8 text-xs py-0"
                                                    >
                                                        <option value="glyph">Glyph</option>
                                                        <option value="chart">Chart</option>
                                                    </Select>
                                                </div>
                                            </div>
                                            <Label className="flex items-start gap-2 text-sm font-normal text-gray-700 dark:text-gray-200 cursor-pointer">
                                                <Checkbox
                                                    className="mt-0.5"
                                                    checked={editingScreen?.componentConfig.showEstimatedBill ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showEstimatedBill: e.target.checked }))}
                                                />
                                                <span className="leading-tight">Estimated Monthly Bill</span>
                                            </Label>
                                        </div>
                                    </div>
                                </div>
                                </SectionCard>

                                <Button onClick={handleSave} disabled={!selectedSite} className="w-full">
                                    Save Changes
                                </Button>
                            </CardBody>
                        </Card>
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
        </PageShell>
    );
}

export default function Page() {
    return (
        <Suspense fallback={<PageShell maxWidth="7xl"><LoadingPanel title="Loading Trmnl manager" /></PageShell>}>
            <ManageContent />
        </Suspense>
    );
}
