'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Label, Input } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { ComparisonPlan, ComparisonVersion } from '@/lib/roi/comparison-tariff-repo';

type CreateForm = { name: string; buy_rate: string; sell_rate: string; effective_from: string };
const EMPTY: CreateForm = { name: '', buy_rate: '', sell_rate: '', effective_from: '' };

export function ComparisonTariffEditor({ siteId, plans, meteredPlanName }: {
    siteId: string; plans: ComparisonPlan[]; meteredPlanName: string;
}) {
    const router = useRouter();
    const { toast } = useToast();
    const base = `/api/site/${siteId}/comparison-tariff`;

    // create form (intent depends on `addVersionFor`: a plan name => append-version, else create)
    const [form, setForm] = useState<CreateForm>(EMPTY);
    const [addVersionFor, setAddVersionFor] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const set = (k: keyof CreateForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

    // inline edit state: keyed by `${plan}@${version}`
    const [editing, setEditing] = useState<string | null>(null);
    const [editForm, setEditForm] = useState({ buy_rate: '', sell_rate: '', effective_from: '' });

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

    async function saveCreate() {
        const intent = addVersionFor ? 'append-version' : 'create';
        const name = addVersionFor ?? form.name;
        const ok = await send('POST', { intent, name, buy_rate: form.buy_rate, sell_rate: form.sell_rate, effective_from: form.effective_from }, 'Comparison plan updated.');
        if (ok) { setForm(EMPTY); setAddVersionFor(null); }
    }

    function beginEdit(plan: string, v: ComparisonVersion) {
        setEditing(`${plan}@${v.version}`);
        setEditForm({ buy_rate: String(v.buy_rate), sell_rate: String(v.sell_rate), effective_from: v.effective_from ?? '' });
    }
    async function saveEdit(plan: string, version: number) {
        const ok = await send('PATCH', {
            name: plan, version,
            buy_rate: editForm.buy_rate, sell_rate: editForm.sell_rate,
            effective_from: editForm.effective_from || null,
        }, 'Version updated.');
        if (ok) setEditing(null);
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
                            <div className="font-medium">{plan.name}</div>
                            <button type="button" tabIndex={0} disabled={busy}
                                onClick={() => send('DELETE', { name: plan.name }, 'Plan deleted.')}
                                className="ml-auto text-xs text-red-600 dark:text-red-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1">
                                Delete plan
                            </button>
                        </div>
                        <div className="mt-2 space-y-2 text-sm">
                            {plan.versions.map(v => {
                                const key = `${plan.name}@${v.version}`;
                                if (editing === key) {
                                    return (
                                        <form key={v.version} onSubmit={(e) => { e.preventDefault(); saveEdit(plan.name, v.version); }}
                                            className="grid grid-cols-2 gap-2 rounded-md bg-bg-muted/40 p-2">
                                            <div className="flex flex-col gap-1"><Label>Buy $/kWh</Label><Input type="number" step="0.00001" value={editForm.buy_rate} onChange={(e) => setEditForm({ ...editForm, buy_rate: e.target.value })} /></div>
                                            <div className="flex flex-col gap-1"><Label>Sell $/kWh</Label><Input type="number" step="0.00001" value={editForm.sell_rate} onChange={(e) => setEditForm({ ...editForm, sell_rate: e.target.value })} /></div>
                                            <div className="flex flex-col gap-1"><Label>Effective from</Label><Input type="date" value={editForm.effective_from} onChange={(e) => setEditForm({ ...editForm, effective_from: e.target.value })} /></div>
                                            <div className="flex items-end gap-2">
                                                <Button type="submit" disabled={busy}>Save</Button>
                                                <button type="button" tabIndex={0} onClick={() => setEditing(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
                                            </div>
                                        </form>
                                    );
                                }
                                return (
                                    <div key={v.version} className="flex items-center gap-3">
                                        <span className="font-mono">${v.buy_rate.toFixed(5)} / kWh</span>
                                        <span className="text-gray-500 dark:text-gray-400">{v.effective_from ?? 'undated'}{v.is_current ? ' · current' : ''}</span>
                                        <span className="ml-auto flex gap-2">
                                            <button type="button" tabIndex={0} onClick={() => beginEdit(plan.name, v)} className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1">Edit</button>
                                            <button type="button" tabIndex={0} disabled={busy} onClick={() => send('DELETE', { name: plan.name, version: v.version }, 'Version deleted.')} className="text-xs text-red-600 dark:text-red-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1">Delete</button>
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                        <button type="button" tabIndex={0}
                            onClick={() => { setAddVersionFor(plan.name); setForm(EMPTY); }}
                            className="mt-2 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1">
                            + add version
                        </button>
                    </div>
                ))}

                <div className="rounded-lg border border-dashed border-gray-300 dark:border-slate-700 p-3 space-y-3">
                    <div className="text-sm font-medium">
                        {addVersionFor ? `Add version to ${addVersionFor}` : 'Add comparison plan'}
                    </div>
                    <form onSubmit={(e) => { e.preventDefault(); saveCreate(); }} className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                            {!addVersionFor && (
                                <div className="flex flex-col gap-1"><Label>Plan name</Label><Input value={form.name} onChange={set('name')} /></div>
                            )}
                            <div className="flex flex-col gap-1"><Label>Effective from</Label><Input type="date" value={form.effective_from} onChange={set('effective_from')} /></div>
                            <div className="flex flex-col gap-1"><Label>Buy rate $/kWh</Label><Input type="number" step="0.00001" value={form.buy_rate} onChange={set('buy_rate')} /></div>
                            <div className="flex flex-col gap-1"><Label>Sell rate $/kWh</Label><Input type="number" step="0.00001" value={form.sell_rate} onChange={set('sell_rate')} /></div>
                        </div>
                        <div className="flex gap-2">
                            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save plan'}</Button>
                            {addVersionFor && (
                                <button type="button" tabIndex={0} onClick={() => { setAddVersionFor(null); setForm(EMPTY); }} className="text-xs text-gray-500 hover:underline">Cancel</button>
                            )}
                        </div>
                    </form>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        Custom TOU comparison plans are coming soon. For now, comparison plans are flat (Fixed) rates.
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}

