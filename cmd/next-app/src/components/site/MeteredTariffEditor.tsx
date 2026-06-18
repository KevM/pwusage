'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { ScheduleEditor, type SchedulePayload } from '@/components/site/ScheduleEditor';
import { buildFixedComparisonInput } from '@/lib/roi/fixed-comparison';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

export interface MeteredVersionSummary {
    version: number;
    effective_from: string | null;
    is_current: boolean;
    kind: 'fixed' | 'tou';
    buy_rate: number;
}

const blankSeed = (): ParsedSeason[] => buildFixedComparisonInput({ name: '', buyRate: 0, sellRate: 0 }).seasons;

type EditState = { version: number; seasons: ParsedSeason[]; effectiveFrom: string };

export function MeteredTariffEditor({ siteId, versions }: { siteId: string; versions: MeteredVersionSummary[] }) {
    const router = useRouter();
    const { toast } = useToast();
    const base = `/api/site/${siteId}/metered-tariff`;

    const [busy, setBusy] = useState(false);
    const [editingDate, setEditingDate] = useState<number | null>(null); // Tesla-current date edit
    const [dateValue, setDateValue] = useState('');
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<EditState | null>(null); // historic rate+date edit

    const floorVersion = versions.reduce((f, v) =>
        (v.effective_from ?? '9999') < (f.effective_from ?? '9999') ? v : f, versions[0]);

    async function send(method: string, body: unknown, okMsg: string): Promise<boolean> {
        setBusy(true);
        try {
            const res = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (res.status >= 400) { const j = await res.json(); throw new Error(j.error || 'request failed'); }
            toast({ title: 'Saved', description: okMsg, variant: 'success' });
            router.refresh();
            return true;
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Could not save.', variant: 'danger' });
            return false;
        } finally { setBusy(false); }
    }

    async function saveDate(version: number) {
        const ok = await send('PATCH', { version, effective_from: dateValue || null }, 'Effective date updated.');
        if (ok) { setEditingDate(null); setDateValue(''); }
    }

    async function onSaveHistoric(payload: SchedulePayload): Promise<boolean> {
        const ok = await send('POST', { switch_date: payload.effectiveFrom || null, seasons: payload.seasons }, 'Historic plan added.');
        if (ok) setAdding(false);
        return ok;
    }

    async function openEdit(version: number, effectiveFrom: string | null) {
        setBusy(true);
        try {
            const res = await fetch(`${base}?version=${version}`);
            if (!res.ok) throw new Error('Could not load that version.');
            const j = await res.json() as { seasons: ParsedSeason[] };
            setEditing({ version, seasons: j.seasons, effectiveFrom: effectiveFrom ?? '' });
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Could not load.', variant: 'danger' });
        } finally { setBusy(false); }
    }

    async function onSaveEdit(payload: SchedulePayload): Promise<boolean> {
        if (!editing) return false;
        const ok = await send('PUT', { version: editing.version, effective_from: payload.effectiveFrom || null, seasons: payload.seasons }, 'Plan updated.');
        if (ok) setEditing(null);
        return ok;
    }

    if (adding) {
        return (
            <Card>
                <CardHeader><CardTitle>Add a historic plan</CardTitle>
                    <CardDescription>Enter a metered plan that ran before your current one. The date you set is when you switched <em>off</em> it onto your next plan — it anchors at your install date and prices the history before the switch.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ScheduleEditor
                        name="Your plan"
                        nameLocked
                        effectiveFrom=""
                        initialSeasons={blankSeed()}
                        cloneSources={[]}
                        onClone={async () => []}
                        onSave={onSaveHistoric}
                        onCancel={() => setAdding(false)}
                    />
                </CardContent>
            </Card>
        );
    }

    if (editing) {
        return (
            <Card>
                <CardHeader><CardTitle>Edit historic plan</CardTitle>
                    <CardDescription>Adjust this past plan&apos;s rates and the date it took effect.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ScheduleEditor
                        name="Your plan"
                        nameLocked
                        effectiveFrom={editing.effectiveFrom}
                        initialSeasons={editing.seasons}
                        cloneSources={[]}
                        onClone={async () => []}
                        onSave={onSaveEdit}
                        onCancel={() => setEditing(null)}
                    />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader><CardTitle>Metered plan history</CardTitle>
                <CardDescription>Your real plan over time, anchored at your install date. Rates for your current plan come from Tesla; set when each version took effect so your savings price each period correctly.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {versions.map(v => (
                    <div key={v.version} className="flex items-center gap-3 text-sm rounded-lg border border-gray-200 dark:border-slate-800 p-3">
                        {v.kind === 'tou'
                            ? <span className="rounded bg-secondary/60 px-1.5 py-0.5 text-xs font-medium">TOU</span>
                            : <span className="font-mono">${v.buy_rate.toFixed(5)} / kWh</span>}
                        {editingDate === v.version ? (
                            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); saveDate(v.version); }}>
                                <Input type="date" className="max-w-44" value={dateValue} onChange={(e) => setDateValue(e.target.value)} />
                                <Button type="submit" size="sm" disabled={busy}>Save</Button>
                                <button type="button" tabIndex={0} onClick={() => setEditingDate(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
                            </form>
                        ) : (
                            <>
                                <span className="text-gray-500 dark:text-gray-400">
                                    {v.version === floorVersion?.version ? `since ${v.effective_from}` : v.effective_from}
                                    {v.is_current ? ' · current' : ''}
                                </span>
                                {v.is_current ? (
                                    <button type="button" tabIndex={0} disabled={busy}
                                        onClick={() => { setEditingDate(v.version); setDateValue(v.effective_from ?? ''); }}
                                        className="ml-auto text-xs text-primary hover:underline rounded px-1">Set date</button>
                                ) : (
                                    <button type="button" tabIndex={0} disabled={busy}
                                        onClick={() => openEdit(v.version, v.effective_from)}
                                        className="ml-auto text-xs text-primary hover:underline rounded px-1">Edit</button>
                                )}
                            </>
                        )}
                    </div>
                ))}
                <Button type="button" onClick={() => setAdding(true)} disabled={busy}>Add historic plan</Button>
            </CardContent>
        </Card>
    );
}
