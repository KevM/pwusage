'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Label, Input } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';

export function ComparisonTariffEditor({ siteId, plans, meteredPlanName }: {
    siteId: string; plans: ComparisonPlan[]; meteredPlanName: string;
}) {
    const router = useRouter();
    const { toast } = useToast();
    const [mode, setMode] = useState<'fixed' | 'tou'>('fixed');
    const [form, setForm] = useState({ name: '', buy_rate: '', sell_rate: '', effective_from: '' });
    const [saving, setSaving] = useState(false);
    const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

    async function save() {
        setSaving(true);
        try {
            const res = await fetch(`/api/site/${siteId}/comparison-tariff`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
            });
            if (res.status === 409) { const j = await res.json(); throw new Error(j.error); }
            if (!res.ok) throw new Error('save failed');
            toast({ title: 'Saved', description: 'Comparison plan updated.', variant: 'success' });
            setForm({ name: '', buy_rate: '', sell_rate: '', effective_from: '' });
            router.refresh();
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Could not save.', variant: 'danger' });
        } finally { setSaving(false); }
    }

    return (
        <Card>
            <CardHeader><CardTitle>Comparison plans</CardTitle>
                <CardDescription>Baselines the savings matrix prices against. Your metered plan ({meteredPlanName}) is managed under Tariff Information.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {plans.map(plan => (
                    <div key={plan.name} className="rounded-lg border border-gray-200 dark:border-slate-800 p-3">
                        <div className="font-medium">{plan.name}</div>
                        <div className="mt-2 space-y-1 text-sm">
                            {plan.versions.map(v => (
                                <div key={v.version} className="flex items-center gap-3">
                                    <span className="font-mono">${v.buy_rate.toFixed(5)} / kWh</span>
                                    <span className="text-gray-500 dark:text-gray-400">{v.effective_from ?? 'undated'}{v.is_current ? ' · current' : ''}</span>
                                </div>
                            ))}
                        </div>
                        {plan.versions.length > 1 && (
                            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                                Past rates are captured for ordering only — savings still use the current rate. Date-based pricing arrives in a later update.
                            </p>
                        )}
                    </div>
                ))}

                <div className="rounded-lg border border-dashed border-gray-300 dark:border-slate-700 p-3 space-y-3">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">Add comparison plan</span>
                        <div className="ml-auto inline-flex rounded-md border border-gray-300 dark:border-slate-700 overflow-hidden text-sm">
                            <button type="button" tabIndex={0} onClick={() => setMode('fixed')}
                                className={`px-3 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:z-10 ${mode === 'fixed' ? 'bg-primary/10 text-primary' : 'text-gray-500'}`}>Fixed</button>
                            <button type="button" tabIndex={0} onClick={() => setMode('tou')}
                                className={`px-3 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:z-10 ${mode === 'tou' ? 'bg-primary/10 text-primary' : 'text-gray-500'}`}>TOU</button>
                        </div>
                    </div>
                    {mode === 'tou' ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            TOU comparison plans arrive in a later update. For now the TOU column uses your metered plan ({meteredPlanName}).
                        </p>
                    ) : (
                        <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <div className="flex flex-col gap-1"><Label>Plan name</Label><Input value={form.name} onChange={set('name')} /></div>
                                <div className="flex flex-col gap-1"><Label>Effective from</Label><Input type="date" value={form.effective_from} onChange={set('effective_from')} /></div>
                                <div className="flex flex-col gap-1"><Label>Buy rate $/kWh</Label><Input type="number" step="0.00001" value={form.buy_rate} onChange={set('buy_rate')} /></div>
                                <div className="flex flex-col gap-1"><Label>Sell rate $/kWh</Label><Input type="number" step="0.00001" value={form.sell_rate} onChange={set('sell_rate')} /></div>
                            </div>
                            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save plan'}</Button>
                        </form>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
