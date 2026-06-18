'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { ScheduleEditor, type CloneSource, type SchedulePayload } from '@/components/site/ScheduleEditor';
import { buildFixedComparisonInput } from '@/lib/roi/fixed-comparison';
import type { ComparisonPlan, ComparisonVersion } from '@/lib/roi/comparison-tariff-repo';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

type EditorIntent = 'create' | 'append-version' | 'replace';
interface EditorState {
    intent: EditorIntent;
    planName: string;
    version?: number;
    effectiveFrom: string;
    seasons: ParsedSeason[];
}

const blankSeed = (): ParsedSeason[] => buildFixedComparisonInput({ name: '', buyRate: 0, sellRate: 0 }).seasons;

export function ComparisonTariffEditor({ siteId, plans, meteredPlanName }: {
    siteId: string; plans: ComparisonPlan[]; meteredPlanName: string;
}) {
    const router = useRouter();
    const { toast } = useToast();
    const base = `/api/site/${siteId}/comparison-tariff`;

    const [busy, setBusy] = useState(false);
    const [editor, setEditor] = useState<EditorState | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameTo, setRenameTo] = useState('');

    // clone seeds: each comparison plan's current version (metered-clone is a deferred follow-on).
    // key encodes name + version so onClone can resolve it via GET.
    const cloneSources: CloneSource[] = plans.flatMap(p =>
        p.versions.filter(v => v.is_current).map(v => ({ label: `${p.name} (current)`, key: `${p.name}@${v.version}` })));

    async function fetchStructure(name: string, version: number): Promise<ParsedSeason[]> {
        const res = await fetch(`${base}?name=${encodeURIComponent(name)}&version=${version}`);
        if (!res.ok) throw new Error('Could not load that version.');
        const j = await res.json() as { seasons: ParsedSeason[] };
        return j.seasons;
    }

    // injected into ScheduleEditor: resolve a clone key (`name@version`) to its structure.
    async function onClone(key: string): Promise<ParsedSeason[]> {
        const at = key.lastIndexOf('@');
        return fetchStructure(key.slice(0, at), Number(key.slice(at + 1)));
    }

    // injected into ScheduleEditor: persist the authored structure per the open intent.
    async function onSave(payload: SchedulePayload): Promise<boolean> {
        const ed = editor!;
        const common = { name: payload.name, effective_from: payload.effectiveFrom || null, seasons: payload.seasons };
        if (ed.intent === 'replace') {
            return send('PATCH', { ...common, version: ed.version }, 'Version updated.');
        }
        return send('POST', { intent: ed.intent, ...common }, 'Comparison plan saved.');
    }

    async function send(method: string, body: unknown, okMsg: string) {
        setBusy(true);
        try {
            const res = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (res.status === 409 || res.status === 400) { const j = await res.json(); throw new Error(j.error); }
            if (!res.ok) throw new Error('request failed');
            toast({ title: 'Saved', description: okMsg, variant: 'success' });
            router.refresh();
            return true;
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Could not save.', variant: 'danger' });
            return false;
        } finally { setBusy(false); }
    }

    function openCreate() {
        setEditor({ intent: 'create', planName: '', effectiveFrom: '', seasons: blankSeed() });
    }
    function openAddVersion(name: string) {
        setEditor({ intent: 'append-version', planName: name, effectiveFrom: '', seasons: blankSeed() });
    }
    async function openEdit(name: string, v: ComparisonVersion) {
        setBusy(true);
        try {
            const seasons = await fetchStructure(name, v.version);
            setEditor({ intent: 'replace', planName: name, version: v.version, effectiveFrom: v.effective_from ?? '', seasons });
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Could not load.', variant: 'danger' });
        } finally { setBusy(false); }
    }

    async function handleRename(oldName: string) {
        const newName = renameTo.trim();
        if (!newName || newName === oldName) { setRenaming(null); return; }
        const ok = await send('PATCH', { intent: 'rename', name: oldName, newName }, 'Plan renamed.');
        if (ok) { setRenaming(null); setRenameTo(''); }
    }

    async function handleDeletePlan(name: string) {
        if (typeof window !== 'undefined' && !window.confirm(`Delete the plan "${name}" and all of its versions?`)) return;
        const ok = await send('DELETE', { name }, 'Plan deleted.');
        if (ok && editor?.planName === name) setEditor(null);
    }
    async function handleDeleteVersion(name: string, version: number) {
        if (typeof window !== 'undefined' && !window.confirm(`Delete version ${version} of "${name}"?`)) return;
        await send('DELETE', { name, version }, 'Version deleted.');
    }

    if (editor) {
        const heading = editor.intent === 'create' ? 'Add comparison plan'
            : editor.intent === 'append-version' ? `Add version to ${editor.planName}`
                : `Edit ${editor.planName} (v${editor.version})`;
        return (
            <Card>
                <CardHeader><CardTitle>{heading}</CardTitle>
                    <CardDescription>Shape the schedule — a single 24/7 window is a Fixed plan; add windows or seasons for Time-of-Use.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ScheduleEditor
                        name={editor.planName}
                        nameLocked={editor.intent !== 'create'}
                        effectiveFrom={editor.effectiveFrom}
                        initialSeasons={editor.seasons}
                        cloneSources={editor.intent === 'create' ? cloneSources : []}
                        onClone={onClone}
                        onSave={onSave}
                        onCancel={() => setEditor(null)}
                    />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader><CardTitle>Comparison plans</CardTitle>
                <CardDescription>Baselines the savings grid prices against, date-resolved over your history. Your metered plan ({meteredPlanName}) is managed under Tariff Information.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {plans.map(plan => (
                    <div key={plan.name} className="rounded-lg border border-gray-200 dark:border-slate-800 p-3">
                        <div className="flex items-center gap-2">
                            {renaming === plan.name ? (
                                <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); handleRename(plan.name); }}>
                                    <Input className="max-w-48" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} />
                                    <Button type="submit" size="sm" disabled={busy}>Save</Button>
                                    <button type="button" tabIndex={0} onClick={() => setRenaming(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
                                </form>
                            ) : (
                                <>
                                    <div className="font-medium">{plan.name}</div>
                                    <button type="button" tabIndex={0} onClick={() => { setRenaming(plan.name); setRenameTo(plan.name); }}
                                        className="text-xs text-primary hover:underline rounded px-1">Rename</button>
                                </>
                            )}
                            <button type="button" tabIndex={0} disabled={busy} onClick={() => handleDeletePlan(plan.name)}
                                className="ml-auto text-xs text-red-600 dark:text-red-400 hover:underline rounded px-1">Delete plan</button>
                        </div>
                        <div className="mt-2 space-y-2 text-sm">
                            {plan.versions.map(v => (
                                <div key={v.version} className="flex items-center gap-3">
                                    {v.kind === 'tou'
                                        ? <span className="rounded bg-secondary/60 px-1.5 py-0.5 text-xs font-medium">TOU</span>
                                        : <span className="font-mono">${v.buy_rate.toFixed(5)} / kWh</span>}
                                    <span className="text-gray-500 dark:text-gray-400">{v.effective_from ?? 'undated'}{v.is_current ? ' · current' : ''}</span>
                                    <span className="ml-auto flex gap-2">
                                        <button type="button" tabIndex={0} disabled={busy} onClick={() => openEdit(plan.name, v)} className="text-xs text-primary hover:underline rounded px-1">Edit</button>
                                        <button type="button" tabIndex={0} disabled={busy} onClick={() => handleDeleteVersion(plan.name, v.version)} className="text-xs text-red-600 dark:text-red-400 hover:underline rounded px-1">Delete</button>
                                    </span>
                                </div>
                            ))}
                        </div>
                        <button type="button" tabIndex={0} disabled={busy} onClick={() => openAddVersion(plan.name)}
                            className="mt-2 text-xs text-primary hover:underline rounded px-1">+ add version</button>
                    </div>
                ))}

                <Button type="button" onClick={openCreate} disabled={busy}>Add comparison plan</Button>
            </CardContent>
        </Card>
    );
}
