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

export function MeteredTariffEditor({ siteId, versions }: { siteId: string; versions: MeteredVersionSummary[] }) {
    const router = useRouter();
    const { toast } = useToast();
    const base = `/api/site/${siteId}/metered-tariff`;

    const [busy, setBusy] = useState(false);
    const [editingDate, setEditingDate] = useState<number | null>(null); // version being date-edited
    const [dateValue, setDateValue] = useState('');
    const [adding, setAdding] = useState(false);

    const earliestVersion = versions.reduce((min, v) => Math.min(min, v.version), Infinity);
    const hasUndated = versions.some(v => v.effective_from === null);

    async function send(method: string, body: unknown, okMsg: string): Promise<boolean> {
        setBusy(true);
        try {
            const res = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (res.status === 400 || res.status === 409) { const j = await res.json(); throw new Error(j.error); }
            if (!res.ok) throw new Error('request failed');
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
        const ok = await send('POST', { effective_from: payload.effectiveFrom || null, seasons: payload.seasons }, 'Historic plan added.');
        if (ok) setAdding(false);
        return ok;
    }

    if (adding) {
        return (
            <Card>
                <CardHeader><CardTitle>Add a historic plan</CardTitle>
                    <CardDescription>Enter a metered plan that was in effect in the past. Set the date it took effect — it prices your history before your current plan.</CardDescription>
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

    return (
        <Card>
            <CardHeader><CardTitle>Metered plan history</CardTitle>
                <CardDescription>Your real plan over time. Rates come from Tesla; set when each version took effect so your savings price each period correctly.</CardDescription>
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
                                    {v.effective_from ?? (v.version === earliestVersion ? 'from the beginning' : 'undated')}
                                    {v.is_current ? ' · current' : ''}
                                </span>
                                <button type="button" tabIndex={0} disabled={busy}
                                    onClick={() => { setEditingDate(v.version); setDateValue(v.effective_from ?? ''); }}
                                    className="ml-auto text-xs text-primary hover:underline rounded px-1">Set date</button>
                            </>
                        )}
                    </div>
                ))}
                {hasUndated && versions.length > 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                        ⚠️ Please set your current plan&apos;s start date first before adding historic plans.
                    </p>
                )}
                <Button type="button" onClick={() => setAdding(true)} disabled={busy || hasUndated}>Add historic plan</Button>
            </CardContent>
        </Card>
    );
}
