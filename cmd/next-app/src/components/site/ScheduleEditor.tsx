'use client';
import { useState } from 'react';
import { Label, Input, Select } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { windowCoverage, scheduleHasGaps } from '@/lib/roi/tou-coverage';
import type { ParsedSeason, ParsedSchedule } from '@/lib/importer/tariff-parser';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // Tesla 0=Mon … 6=Sun

export interface CloneSource { label: string; key: string }
export interface SchedulePayload { name: string; effectiveFrom: string; seasons: ParsedSeason[] }

// Editable counterpart types allowing transient empty strings in inputs
interface EditableSchedule {
    name: string;
    buy_rate: number | string;
    sell_rate: number | string;
    from_day_of_week: number;
    to_day_of_week: number;
    from_hour: number | string;
    from_minute: number;
    to_hour: number | string;
    to_minute: number;
}

interface EditableSeason {
    name: string;
    from_month: number | string;
    from_day: number | string;
    to_month: number | string;
    to_day: number | string;
    buy_rate: number;
    sell_rate: number;
    schedules: EditableSchedule[];
}

function blankWindow(): EditableSchedule {
    return {
        name: 'Window', buy_rate: '', sell_rate: '',
        from_day_of_week: 0, to_day_of_week: 6, from_hour: '', from_minute: 0, to_hour: '', to_minute: 0,
    };
}

function cleanSeasons(seasons: EditableSeason[]): ParsedSeason[] {
    return seasons.map(s => ({
        ...s,
        from_month: s.from_month === '' ? 0 : Number(s.from_month),
        from_day: s.from_day === '' ? 0 : Number(s.from_day),
        to_month: s.to_month === '' ? 0 : Number(s.to_month),
        to_day: s.to_day === '' ? 0 : Number(s.to_day),
        buy_rate: Number(s.buy_rate) || 0,
        sell_rate: Number(s.sell_rate) || 0,
        schedules: s.schedules.map(w => ({
            ...w,
            buy_rate: w.buy_rate === '' ? 0 : Number(w.buy_rate),
            sell_rate: w.sell_rate === '' ? 0 : Number(w.sell_rate),
            from_hour: w.from_hour === '' ? 0 : Number(w.from_hour),
            to_hour: w.to_hour === '' ? 0 : Number(w.to_hour),
        }))
    }));
}

/** Route-agnostic schedule structure editor. Owns no HTTP and no comparison-vs-metered
 *  semantics — the caller wires `onSave` (persist the authored structure) and the optional
 *  `onClone` (resolve a seed for a chosen source). Reusable for any Tariff→Season→Schedule
 *  authoring surface (comparison plans now; historical metered tariffs later). */
export function ScheduleEditor({
    name: initialName, nameLocked = false, nameLabel = 'Plan name',
    effectiveFrom, initialSeasons, cloneSources = [], onClone, onSave, onCancel,
}: {
    name: string;
    nameLocked?: boolean;
    nameLabel?: string;
    effectiveFrom: string;
    initialSeasons: ParsedSeason[];
    cloneSources?: CloneSource[];
    onClone?: (key: string) => Promise<ParsedSeason[]>;
    onSave: (payload: SchedulePayload) => Promise<boolean>;
    onCancel: () => void;
}) {
    const { toast } = useToast();

    const [name, setName] = useState(initialName);
    const [effFrom, setEffFrom] = useState(effectiveFrom);
    const [seasons, setSeasons] = useState<EditableSeason[]>(() => structuredClone(initialSeasons) as EditableSeason[]);
    const [busy, setBusy] = useState(false);

    const cleanedSeasons = cleanSeasons(seasons);
    const hasGaps = scheduleHasGaps(cleanedSeasons);

    // ---- structure mutation helpers (immutable) ----
    function patchSeason(si: number, patch: Partial<EditableSeason>) {
        setSeasons(prev => prev.map((s, i) => (i === si ? { ...s, ...patch } : s)));
    }
    function patchWindow(si: number, wi: number, patch: Partial<EditableSchedule>) {
        setSeasons(prev => prev.map((s, i) => i === si
            ? { ...s, schedules: s.schedules.map((w, j) => (j === wi ? { ...w, ...patch } : w)) }
            : s));
    }
    function addWindow(si: number) {
        setSeasons(prev => prev.map((s, i) => i === si ? { ...s, schedules: [...s.schedules, blankWindow()] } : s));
    }
    function removeWindow(si: number, wi: number) {
        setSeasons(prev => prev.map((s, i) => i === si ? { ...s, schedules: s.schedules.filter((_, j) => j !== wi) } : s));
    }
    function addSeason() {
        setSeasons(prev => [...prev, {
            name: 'New season', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: 0, sell_rate: 0, schedules: [blankWindow()],
        }]);
    }
    function removeSeason(si: number) {
        setSeasons(prev => prev.filter((_, i) => i !== si));
    }

    // ---- clone + save (HTTP lives in the injected callbacks) ----
    async function cloneFrom(src: CloneSource) {
        if (!onClone) return;
        setBusy(true);
        try {
            const next = await onClone(src.key);
            setSeasons(structuredClone(next) as EditableSeason[]);
            toast({ title: 'Cloned', description: `Seeded from ${src.label}.`, variant: 'success' });
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Clone failed.', variant: 'danger' });
        } finally { setBusy(false); }
    }

    async function save() {
        setBusy(true);
        try {
            const ok = await onSave({ name: name.trim(), effectiveFrom: effFrom, seasons: cleanSeasons(seasons) });
            if (ok) onCancel();
        } finally { setBusy(false); }
    }

    return (
        <div className="space-y-4 rounded-lg border border-gray-200 dark:border-slate-800 p-3">
            <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                    <Label>{nameLabel}</Label>
                    <Input value={name} disabled={nameLocked} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1">
                    <Label>Effective from</Label>
                    <Input type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} />
                </div>
            </div>

            {onClone && cloneSources.length > 0 && (
                <div className="flex flex-col gap-1">
                    <Label>Clone from (optional)</Label>
                    <Select defaultValue="" disabled={busy}
                        onChange={(e) => { const s = cloneSources.find(c => c.key === e.target.value); if (s) cloneFrom(s); }}>
                        <option value="">Start from scratch (flat)</option>
                        {cloneSources.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </Select>
                </div>
            )}

            {seasons.map((season, si) => {
                const cleanedSeason = cleanSeasons([season])[0];
                const { grid } = windowCoverage(cleanedSeason);
                return (
                    <div key={si} className="rounded-md border border-gray-200 dark:border-slate-800 p-3 space-y-3">
                        <div className="flex items-center gap-2">
                            <Input className="max-w-48" value={season.name} onChange={(e) => patchSeason(si, { name: e.target.value })} />
                            {seasons.length > 1 && (
                                <button type="button" tabIndex={0} onClick={() => removeSeason(si)}
                                    className="ml-auto text-xs text-red-600 dark:text-red-400 hover:underline rounded px-1">Remove season</button>
                            )}
                        </div>
                        <div className="grid grid-cols-4 gap-2 text-xs">
                            <div className="flex flex-col gap-1"><Label>From month</Label><Input type="number" min={1} max={12} value={season.from_month} onChange={(e) => patchSeason(si, { from_month: e.target.value })} /></div>
                            <div className="flex flex-col gap-1"><Label>From day</Label><Input type="number" min={1} max={31} value={season.from_day} onChange={(e) => patchSeason(si, { from_day: e.target.value })} /></div>
                            <div className="flex flex-col gap-1"><Label>To month</Label><Input type="number" min={1} max={12} value={season.to_month} onChange={(e) => patchSeason(si, { to_month: e.target.value })} /></div>
                            <div className="flex flex-col gap-1"><Label>To day</Label><Input type="number" min={1} max={31} value={season.to_day} onChange={(e) => patchSeason(si, { to_day: e.target.value })} /></div>
                        </div>

                        <div className="space-y-2">
                            {season.schedules.map((w, wi) => (
                                <div key={wi} className="grid grid-cols-6 gap-2 items-end text-xs">
                                    <div className="flex flex-col gap-1"><Label>From day</Label>
                                        <Select value={w.from_day_of_week} onChange={(e) => patchWindow(si, wi, { from_day_of_week: Number(e.target.value) })}>
                                            {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                                        </Select>
                                    </div>
                                    <div className="flex flex-col gap-1"><Label>To day</Label>
                                        <Select value={w.to_day_of_week} onChange={(e) => patchWindow(si, wi, { to_day_of_week: Number(e.target.value) })}>
                                            {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                                        </Select>
                                    </div>
                                    <div className="flex flex-col gap-1"><Label>From hour</Label><Input type="number" min={0} max={24} value={w.from_hour} onChange={(e) => patchWindow(si, wi, { from_hour: e.target.value })} /></div>
                                    <div className="flex flex-col gap-1"><Label>To hour</Label><Input type="number" min={0} max={24} value={w.to_hour} onChange={(e) => patchWindow(si, wi, { to_hour: e.target.value })} /></div>
                                    <div className="flex flex-col gap-1"><Label>Buy $/kWh</Label><Input type="number" step="0.00001" value={w.buy_rate} onChange={(e) => patchWindow(si, wi, { buy_rate: e.target.value })} /></div>
                                    <div className="flex items-end gap-1">
                                        <div className="flex flex-col gap-1 flex-1"><Label>Sell $/kWh</Label><Input type="number" step="0.00001" value={w.sell_rate} onChange={(e) => patchWindow(si, wi, { sell_rate: e.target.value })} /></div>
                                        {season.schedules.length > 1 && (
                                            <button type="button" tabIndex={0} onClick={() => removeWindow(si, wi)}
                                                className="text-xs text-red-600 dark:text-red-400 hover:underline rounded px-1 pb-2">✕</button>
                                        )}
                                    </div>
                                </div>
                            ))}
                            <button type="button" tabIndex={0} onClick={() => addWindow(si)}
                                className="text-xs text-primary hover:underline rounded px-1">+ add window</button>
                        </div>

                        {/* coverage heatmap — Tesla weekday (0=Mon) rows × 24 hour columns */}
                        <div className="space-y-0.5">
                            {grid.map((row, weekday) => (
                                <div key={weekday} className="flex items-center gap-1">
                                    <span className="w-8 text-[10px] text-gray-500 dark:text-gray-400">{DAYS[weekday]}</span>
                                    <div className="flex gap-px">
                                        {row.map((covered, hour) => (
                                            <span key={hour}
                                                // data-gap is used for node static-rendering assertions in tests (asserting coverage gaps)
                                                data-gap={covered ? undefined : 'true'}
                                                title={`${DAYS[weekday]} ${String(hour).padStart(2, '0')}:00${covered ? '' : ' — uncovered'}`}
                                                className={`inline-block h-2.5 w-2.5 rounded-[1px] ${covered ? 'bg-primary/40' : 'bg-red-500'}`} />
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}

            <button type="button" tabIndex={0} onClick={addSeason}
                className="text-xs text-primary hover:underline rounded px-1">+ add season</button>

            {hasGaps && (
                <p className="text-xs text-red-600 dark:text-red-400">Every day of the year and every hour must be covered (red cells above) before you can save.</p>
            )}

            <div className="flex gap-2">
                {/* data-disabled is preserved in node-env static markup tests to assert Save-button state */}
                <Button type="button" data-disabled={String(hasGaps || busy)} disabled={hasGaps || busy} onClick={save}>
                    {busy ? 'Saving…' : 'Save plan'}
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
            </div>
        </div>
    );
}
