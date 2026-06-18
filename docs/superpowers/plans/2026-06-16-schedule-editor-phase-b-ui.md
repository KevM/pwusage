# Schedule Editor — Phase B (Authoring UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the client-side **Schedule Editor** that authors a comparison plan's full Tariff→Season→Schedule structure (Fixed = the degenerate one-window case, TOU = anything richer), and rewire `ComparisonTariffEditor` to drive it — reconnecting the comparison-plan UI to the structure-based route that Phase A shipped (the current flat editor POSTs a `buy_rate`/`sell_rate` body the route no longer accepts, so create/edit/append are currently broken).

**Architecture:** `ScheduleEditor` is a **route-agnostic, reusable** structure editor: it renders seasons (date-range + a window table of day/hour/rate rows) with add/remove, a live read-only 7×24 coverage heatmap per season (driven by the **same** `tou-coverage` resolver the server validates with), and a Save gated on full coverage. It does **not** fetch or know about the comparison-tariff route/intents — it reports the authored `{ name, effectiveFrom, seasons }` through an injected `onSave` callback and reseeds through an injected `onClone`. The comparison-specific glue (create / edit-in-place / append-version intents, version numbers, clone `GET`, the Fixed/TOU badge, plan rename) lives in `ComparisonTariffEditor` as the *caller*. This decoupling is deliberate: a later **historical metered-tariff entry** screen (let a new user backfill past tariffs no longer in effect, against the metered `TariffRepo` lineage) reuses the same `ScheduleEditor` by supplying its own `onSave`/`onClone`. **No backend changes** — Phase A already shipped the comparison repo methods, the route (`GET`/`POST`/`PATCH`/`DELETE` over `seasons[]` with a server coverage check), the kind-aware listing, and the date-resolved grid pricing.

**Tech Stack:** Next.js (App Router) `'use client'` components, TypeScript, Tailwind, Vitest. Component tests run under `environment: 'node'` (no jsdom/RTL): render with `renderToStaticMarkup`, mock `next/navigation` + `@/components/ui/Toast`, and assert on the HTML string. Interactivity (fetch on click) is not exercised in static render and is covered by the existing route tests.

**Spec:** `docs/superpowers/specs/2026-06-16-schedule-editor-design.md` — this is the **editor + manager-wiring** half (the "structures/headless" half shipped as Phase A: `2026-06-16-schedule-editor-phase-a-structures.md`).

**Conventions to mirror:**
- Component test: `src/components/site/ComparisonTariffEditor.test.tsx` — `vi.mock('next/navigation', …)` + `vi.mock('@/components/ui/Toast', …)`, then `renderToStaticMarkup(<… />)` and assert on the HTML string.
- Pure-unit test: `src/lib/roi/tou-coverage.test.ts` — direct calls, no mocks.
- Fetch + toast pattern: the existing `send()` helper in `ComparisonTariffEditor.tsx` (409/400 → `throw new Error(j.error)`, success → toast + `router.refresh()`).
- Day-of-week is **Tesla `0=Mon … 6=Sun`** (same as `lib/schedule.ts`, `TariffList.getDayName`). The editor shows human labels and stores the integer.
- All commands run from `cmd/next-app`.

---

## Key facts grounding this plan (verified against the code)

- **A schedule is `ParsedSeason[]`.** `ParsedSeason` ([tariff-parser.ts:16](../../cmd/next-app/src/lib/importer/tariff-parser.ts)) = `{ name, from_month, from_day, to_month, to_day, buy_rate, sell_rate, schedules: ParsedSchedule[] }`; `ParsedSchedule` = `{ name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute }` (all non-null numbers). The route, repo, and coverage unit all speak `ParsedSeason[]`.
- **Coverage is the safety invariant, computed by `tou-coverage.ts`** ([tou-coverage.ts](../../cmd/next-app/src/lib/roi/tou-coverage.ts)). `windowCoverage(season)` → `{ grid: boolean[7][24], gaps: Cell[] }` (Tesla weekday × hour); `seasonCalendarGaps(seasons)` → days of a leap reference year matched by ≠1 season. Both already shipped + tested. The editor reuses them so client preview and server validation agree.
- **The route is structure-based** ([route.ts](../../cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts)):
  - `GET ?name=&version=` → `{ name, seasons }` (full parsed structure; reads **any** tariff, metered or comparison — a valid clone seed). 404 when absent.
  - `POST { intent, name, effective_from, seasons }` → create (rejects an existing comparison name 409 unless `intent:'append-version'`) / append-version. Runs `coverageError(seasons)` → 400 on a gap; metered-name collision → 409.
  - `PATCH { name, version, effective_from, seasons }` → replace a version's structure in place (coverage-checked). `PATCH { intent:'rename', name, newName }` → rename a plan (collision-guarded 409).
  - `DELETE { name, version? }` → delete a version or the whole plan (shipped in the manager-CRUD phase, unchanged).
- **`coverageError`** ([route.ts:10](../../cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts)) returns a human message for the first calendar/window gap, else `null`. The editor's client gate must match it (no gaps ⇒ Save enabled).
- **`listFixedComparisons`** ([comparison-tariff-repo.ts:113](../../cmd/next-app/src/lib/roi/comparison-tariff-repo.ts)) now returns `ComparisonVersion` with a rate-based `kind: 'fixed' | 'tou'` per version plus a representative `buy_rate`/`sell_rate`. The manager already receives these via `plans`.
- **The blank-flat seed** is `buildFixedComparisonInput({ name, buyRate, sellRate }).seasons` ([fixed-comparison.ts:12](../../cmd/next-app/src/lib/roi/fixed-comparison.ts)) — one all-year season, one 24/7 all-week window. Coverage-valid by construction.
- **UI primitives:** `Label`, `Input`, `Select` from `@/components/ui/Form` ([Form.tsx](../../cmd/next-app/src/components/ui/Form.tsx)) (all spread native props; `Select` wraps `<select>`); `Button` from `@/components/ui/Button` (`variant`/`size`/`disabled`). `Card*` from `@/components/ui/Card`. `useToast()` → `{ toast({ title, description, variant }) }`.
- **Manager threading:** `page.tsx` → `SavingsView` → `SavingsSettings` → `ComparisonTariffEditor({ siteId, plans, meteredPlanName })`. No prop changes needed for this phase.

---

## File Structure

**Create:**
- `cmd/next-app/src/components/site/ScheduleEditor.tsx` — the `'use client'`, **route-agnostic** editor: seasons/windows form tables + per-season coverage heatmap + clone `<select>` + gap-gated Save. No fetch; reports via injected `onSave`/`onClone`. Reusable beyond comparison plans (e.g. future historical metered entry).
- `cmd/next-app/src/components/site/ScheduleEditor.test.tsx` — render tests (flat seed = no gaps + Save enabled; gapped seed = red heatmap cell + Save disabled).

**Modify:**
- `cmd/next-app/src/lib/roi/tou-coverage.ts` — add `scheduleHasGaps(seasons)` (one boolean over calendar + window gaps; the editor's Save gate).
- `cmd/next-app/src/lib/roi/tou-coverage.test.ts` — cover `scheduleHasGaps`.
- `cmd/next-app/src/components/site/ComparisonTariffEditor.tsx` — replace the flat create form + rate-only inline edit with entry points into `ScheduleEditor` (Add plan / per-version Edit→`replace` / per-plan + add version); add the Fixed/TOU badge and plan rename. Keep the shipped list + delete affordances.
- `cmd/next-app/src/components/site/ComparisonTariffEditor.test.tsx` — assert the new controls + badge; drop the flat-form assertions.

**Untouched (explicitly):** all of Phase A's backend (`comparison-tariff-repo.ts`, `route.ts`, `plan-timeline.ts`, `page.tsx`, `tou-coverage`'s existing exports), `schedule.ts`, `extended-grid.ts`, `SavingsView.tsx`/`SavingsSettings.tsx` (no prop changes), `resolve-fixed-baseline.ts` (stays Fixed-oriented per spec caveat).

**Deferred (each a later plan, per the design's "Out of scope"):** **clone-from-metered** (the `Tariff` type doesn't expose `version`; offering the metered plan as a clone seed needs the metered loader to surface it — a separate small change); **historical metered entry**; **sub-hour windows**; re-pointing the payback summary at a date-resolved baseline.

---

## Task 1: `scheduleHasGaps` — the Save gate

A single boolean over a whole structure: any calendar day matched by ≠1 season, or any `(weekday, hour)` left unresolved in any season. The editor disables Save while this is true; it mirrors the server's `coverageError` (gap ⇒ reject).

**Files:**
- Modify: `cmd/next-app/src/lib/roi/tou-coverage.ts`
- Test: `cmd/next-app/src/lib/roi/tou-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `src/lib/roi/tou-coverage.test.ts`:

```ts
describe('scheduleHasGaps', () => {
    const flatWindow = {
        name: 'Flat', buy_rate: 0.3, sell_rate: 0.05,
        from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
    };
    const allYear = (schedules: typeof flatWindow[]) => ([{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.3, sell_rate: 0.05, schedules,
    }]);

    it('is false for a full-year/full-week flat plan', () => {
        expect(scheduleHasGaps(allYear([flatWindow]))).toBe(false);
    });

    it('is true when a window leaves hours uncovered', () => {
        expect(scheduleHasGaps(allYear([{ ...flatWindow, from_hour: 6, to_hour: 22 }]))).toBe(true);
    });

    it('is true when seasons leave a calendar day uncovered', () => {
        const jan = { name: 'Jan', from_month: 1, from_day: 1, to_month: 1, to_day: 31, buy_rate: 0.3, sell_rate: 0.05, schedules: [flatWindow] };
        expect(scheduleHasGaps([jan])).toBe(true); // Feb–Dec uncovered
    });
});
```

Add the import at the top of the test file if `scheduleHasGaps` is not already imported from `./tou-coverage` (extend the existing import line).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/tou-coverage`
Expected: FAIL — `scheduleHasGaps is not a function`.

- [ ] **Step 3: Implement `scheduleHasGaps`**

Append to `src/lib/roi/tou-coverage.ts` (after `isFixedSchedule`):

```ts
/** True when a structure is not fully covered: any calendar day matched by ≠1 season,
 *  or any (weekday, hour) left unresolved in any season. Mirrors the server's coverage
 *  check (route `coverageError`); the editor disables Save while this is true. */
export function scheduleHasGaps(seasons: ParsedSeason[]): boolean {
    if (seasons.length === 0) return true;
    if (seasonCalendarGaps(seasons).length > 0) return true;
    return seasons.some(s => windowCoverage(s).gaps.length > 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/tou-coverage`
Expected: PASS — the new cases and the pre-existing coverage cases.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/tou-coverage.ts cmd/next-app/src/lib/roi/tou-coverage.test.ts
git commit -m "feat(roi): scheduleHasGaps — whole-structure coverage gate for the editor"
```

---

## Task 2: `ScheduleEditor.tsx` — the reusable authoring component

One editor for Fixed and TOU, **decoupled from any route**. Renders a name field (editable or locked via prop), an effective-from date, an optional clone `<select>`, then one card per season (date range + a window table of day/hour/rate rows with add/remove, and a 7×24 coverage heatmap), an add-season button, and a Save button gated by `scheduleHasGaps`. It does not fetch: **Save calls the injected `onSave({ name, effectiveFrom, seasons })`** (async → returns a success boolean; the editor closes via `onCancel`/the caller on success), and **clone calls the injected `onClone(source)`** (async → returns the seed `ParsedSeason[]`). The caller owns all HTTP and all comparison-vs-metered semantics, which is what makes the editor reusable.

For node-env testability: the editor never fetches, so `renderToStaticMarkup` is trivially safe; tests pass no-op `onSave`/`onClone`. Coverage state is rendered into deterministic attributes (`data-gap`, `data-disabled`) so the static HTML is assertable.

**Files:**
- Create: `cmd/next-app/src/components/site/ScheduleEditor.tsx`
- Test: `cmd/next-app/src/components/site/ScheduleEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/site/ScheduleEditor.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: () => {} }) }));

import { ScheduleEditor } from './ScheduleEditor';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

const flatWindow = {
    name: 'Flat', buy_rate: 0.3, sell_rate: 0.05,
    from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
};
const flat: ParsedSeason[] = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
    buy_rate: 0.3, sell_rate: 0.05, schedules: [flatWindow],
}];
const gapped: ParsedSeason[] = [{ ...flat[0], schedules: [{ ...flatWindow, from_hour: 6, to_hour: 22 }] }];

function render(seasons: ParsedSeason[]) {
    return renderToStaticMarkup(
        <ScheduleEditor
            name="" nameLocked={false} effectiveFrom=""
            initialSeasons={seasons}
            onSave={async () => true} onCancel={() => {}}
        />,
    );
}

describe('ScheduleEditor', () => {
    it('renders the season and a window row from the seed', () => {
        const html = render(flat);
        expect(html).toContain('All Year');
        expect(html).toMatch(/0\.3/);     // window buy rate
        expect(html).toMatch(/Mon/);      // day label
    });

    it('a fully-covered flat seed reports no gaps and enables Save', () => {
        const html = render(flat);
        expect(html).not.toContain('data-gap="true"');
        expect(html).toContain('data-disabled="false"');
    });

    it('a gapped seed lights the heatmap red and disables Save', () => {
        const html = render(gapped);
        expect(html).toContain('data-gap="true"');
        expect(html).toContain('data-disabled="true"');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/site/ScheduleEditor`
Expected: FAIL — cannot resolve `./ScheduleEditor`.

- [ ] **Step 3: Implement `ScheduleEditor`**

Create `src/components/site/ScheduleEditor.tsx`:

```tsx
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

function blankWindow(): ParsedSchedule {
    return {
        name: 'Window', buy_rate: 0, sell_rate: 0,
        from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
    };
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
    const [seasons, setSeasons] = useState<ParsedSeason[]>(() => structuredClone(initialSeasons));
    const [busy, setBusy] = useState(false);

    const hasGaps = scheduleHasGaps(seasons);

    // ---- structure mutation helpers (immutable) ----
    function patchSeason(si: number, patch: Partial<ParsedSeason>) {
        setSeasons(prev => prev.map((s, i) => (i === si ? { ...s, ...patch } : s)));
    }
    function patchWindow(si: number, wi: number, patch: Partial<ParsedSchedule>) {
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
            setSeasons(structuredClone(next));
            toast({ title: 'Cloned', description: `Seeded from ${src.label}.`, variant: 'success' });
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Clone failed.', variant: 'danger' });
        } finally { setBusy(false); }
    }

    async function save() {
        setBusy(true);
        try {
            const ok = await onSave({ name: name.trim(), effectiveFrom: effFrom, seasons });
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
                const { grid } = windowCoverage(season);
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
                            <div className="flex flex-col gap-1"><Label>From month</Label><Input type="number" min={1} max={12} value={season.from_month} onChange={(e) => patchSeason(si, { from_month: Number(e.target.value) })} /></div>
                            <div className="flex flex-col gap-1"><Label>From day</Label><Input type="number" min={1} max={31} value={season.from_day} onChange={(e) => patchSeason(si, { from_day: Number(e.target.value) })} /></div>
                            <div className="flex flex-col gap-1"><Label>To month</Label><Input type="number" min={1} max={12} value={season.to_month} onChange={(e) => patchSeason(si, { to_month: Number(e.target.value) })} /></div>
                            <div className="flex flex-col gap-1"><Label>To day</Label><Input type="number" min={1} max={31} value={season.to_day} onChange={(e) => patchSeason(si, { to_day: Number(e.target.value) })} /></div>
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
                                    <div className="flex flex-col gap-1"><Label>From hour</Label><Input type="number" min={0} max={24} value={w.from_hour} onChange={(e) => patchWindow(si, wi, { from_hour: Number(e.target.value) })} /></div>
                                    <div className="flex flex-col gap-1"><Label>To hour</Label><Input type="number" min={0} max={24} value={w.to_hour} onChange={(e) => patchWindow(si, wi, { to_hour: Number(e.target.value) })} /></div>
                                    <div className="flex flex-col gap-1"><Label>Buy $/kWh</Label><Input type="number" step="0.00001" value={w.buy_rate} onChange={(e) => patchWindow(si, wi, { buy_rate: Number(e.target.value) })} /></div>
                                    <div className="flex items-end gap-1">
                                        <div className="flex flex-col gap-1 flex-1"><Label>Sell $/kWh</Label><Input type="number" step="0.00001" value={w.sell_rate} onChange={(e) => patchWindow(si, wi, { sell_rate: Number(e.target.value) })} /></div>
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
                <Button type="button" data-disabled={String(hasGaps || busy)} disabled={hasGaps || busy} onClick={save}>
                    {busy ? 'Saving…' : 'Save plan'}
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
            </div>
        </div>
    );
}
```

> Note: `data-disabled` is rendered as a string ("true"/"false") so it is always present in static markup (a falsy `disabled` is omitted by React, but `data-disabled` is not), giving the test a deterministic Save-state assertion. `data-gap` is set only on uncovered cells.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/site/ScheduleEditor`
Expected: PASS — all three cases.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/ScheduleEditor.tsx cmd/next-app/src/components/site/ScheduleEditor.test.tsx
git commit -m "feat(savings): ScheduleEditor — Fixed/TOU comparison authoring with coverage heatmap"
```

---

## Task 3: Rewire `ComparisonTariffEditor` to drive the editor

Replace the flat create form and rate-only inline edit with entry points into `ScheduleEditor`: **Add comparison plan** (create, blank seed, clone choices), per-version **Edit** (`GET` the structure → `replace`), per-plan **+ add version** (`append-version`, name locked). Add the derived **Fixed/TOU badge** per version and a per-plan **Rename**. Keep the shipped list + delete affordances.

**Files:**
- Modify: `cmd/next-app/src/components/site/ComparisonTariffEditor.tsx`
- Test: `cmd/next-app/src/components/site/ComparisonTariffEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

Replace the contents of `src/components/site/ComparisonTariffEditor.test.tsx` with:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: () => {} }) }));

import { ComparisonTariffEditor } from './ComparisonTariffEditor';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';

const plans: ComparisonPlan[] = [
    { name: 'EV Plan', versions: [
        { version: 2, is_current: true, effective_from: '2025-06-01', buy_rate: 0.30, sell_rate: 0.05, kind: 'tou' },
        { version: 1, is_current: false, effective_from: '2024-01-01', buy_rate: 0.20, sell_rate: 0.04, kind: 'fixed' },
    ] },
];

function render() {
    return renderToStaticMarkup(<ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" />);
}

describe('ComparisonTariffEditor', () => {
    it('renders the plan name and each version', () => {
        const html = render();
        expect(html).toContain('EV Plan');
        expect(html).toContain('2025-06-01');
        expect(html).toContain('2024-01-01');
    });

    it('derives a Fixed/TOU badge per version', () => {
        const html = render();
        expect(html).toMatch(/TOU/);          // version 2 (kind: tou)
        expect(html).toMatch(/0\.20000/);     // version 1 (fixed) shows its rate
    });

    it('exposes create / edit / add-version / rename / delete entry points', () => {
        const html = render();
        expect(html).toMatch(/add comparison plan/i);
        expect(html).toMatch(/edit/i);
        expect(html).toMatch(/add version/i);
        expect(html).toMatch(/rename/i);
        expect(html).toMatch(/delete/i);
    });

    it('no longer carries the flat "coming soon" note', () => {
        const html = render();
        expect(html).not.toMatch(/coming soon/i);
        expect(html).not.toMatch(/Date-based pricing arrives/i);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/site/ComparisonTariffEditor`
Expected: FAIL — no badge / no "Add comparison plan" / no "Rename"; the flat note still present.

- [ ] **Step 3: Implement the rewired manager**

Replace the whole contents of `src/components/site/ComparisonTariffEditor.tsx` with:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Label, Input } from '@/components/ui/Form';
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/site/ComparisonTariffEditor`
Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/ComparisonTariffEditor.tsx cmd/next-app/src/components/site/ComparisonTariffEditor.test.tsx
git commit -m "feat(savings): comparison manager drives ScheduleEditor — create/edit/add-version, rename, Fixed/TOU badge"
```

---

## Task 4: Final verification

- [ ] **Step 1: Full test suite**

Run: `cd cmd/next-app && npm test`
Expected: all pass — including `tou-coverage`, `ScheduleEditor`, and `ComparisonTariffEditor`.

- [ ] **Step 2: Build + lint + typecheck**

Run: `cd cmd/next-app && npm run build && npm run lint && npx tsc --noEmit`
Expected: all pass. (Watch for unused imports left from the old flat editor — `ComparisonVersion` is still used; remove anything the new editor dropped.)

- [ ] **Step 3: Confirm the manager reaches the structure route and the editor stays route-agnostic**

Run: `cd cmd/next-app && grep -n "fetch\|intent\|seasons\|version" src/components/site/ComparisonTariffEditor.tsx | head -20`
Expected: the **manager** sends `{ intent, name, effective_from, seasons }` on `POST` and `{ name, version, effective_from, seasons }` on `PATCH` — matching the Phase A route; the old flat `buy_rate`/`sell_rate` POST body is gone, so create/edit/append work again.

Run: `cd cmd/next-app && grep -c "fetch" src/components/site/ScheduleEditor.tsx`
Expected: `0` — the editor owns no HTTP (the reuse boundary holds).

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(savings): Schedule Editor Phase B green" || echo "nothing to commit"
```

---

## Self-review notes (for the implementer)

- **The bug this closes.** Phase A repointed the route at a `seasons[]` payload + server coverage check, but left `ComparisonTariffEditor` POSTing the old `{ buy_rate, sell_rate }` body — so create/edit/append currently 400 (`coverageError` sees no seasons). Task 3 is what reconnects the UI; verify create actually persists end-to-end once built.
- **Client and server agree on coverage by construction.** The editor's Save gate (`scheduleHasGaps`) and the server's `coverageError` both call the same `tou-coverage` functions over the same `ParsedSeason[]`. Don't reimplement coverage in the component — reuse the unit, or they will drift.
- **Canonicalization is server-side only (decision 9).** The editor does **not** collapse same-rate windows live (that would delete a window the user just added before they set its rate). `saveComparisonStructure` canonicalizes on save; the stored shape and the rate-based badge agree afterward. The editor's heatmap shows the *authored* structure, which is correct.
- **Why `data-gap` / `data-disabled`.** Component tests run under `environment: 'node'` (no jsdom), so they assert on `renderToStaticMarkup` output. A falsy `disabled` attribute is omitted by React, so the Save-state can't be read from `disabled` alone; `data-disabled={String(...)}` is always present. `data-gap="true"` marks only uncovered heatmap cells. These attributes are the test contract — keep them.
- **Day-of-week is Tesla `0=Mon … 6=Sun`** everywhere (selects store the integer, labels come from `DAYS`). This matches `lib/schedule.ts`, `tou-coverage`, and `TariffList`. A flat plan's window is `0..6 / 0..24` — the blank seed (`buildFixedComparisonInput`) already is exactly that, and passes coverage trivially.
- **`ScheduleEditor` owns no HTTP — keep it that way.** Save and clone go through the injected `onSave`/`onClone`; the editor never imports `fetch`, the comparison route, or any intent/version semantics. This is the load-bearing reuse boundary: the deferred **historical metered-tariff entry** screen will mount the *same* `ScheduleEditor` with `onSave` that writes the metered `TariffRepo` lineage and `onClone` that seeds from a past metered version. Do not push comparison-specific logic down into the editor "for convenience" — it belongs in the caller (`ComparisonTariffEditor`). Because the editor never fetches, `renderToStaticMarkup` tests need no fetch mock; the write paths are covered by the existing route tests.
- **Deferred, not forgotten:** clone-from-metered (needs `Tariff.version` surfaced by the metered loader), historical metered entry, sub-hour windows, and re-pointing the payback summary at a date-resolved baseline. Each is its own follow-on; none blocks shipping a working Fixed/TOU comparison editor.
