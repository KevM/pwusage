# Savings Config Co-location & Rollup Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move savings configuration onto the Savings tab, auto-advance the in-process rollup view, and stop the "Index history" start button from reappearing while a backfill is mid-flight in an `error` state.

**Architecture:** A small pure module (`savings-status.ts`) centralizes the "is this backfill still in process / terminal / which view state" decisions so they are unit-testable. `SavingsView` switches on that state; a new `SavingsSettings` disclosure component co-locates the existing `RoiConfigForm` + `ComparisonTariffEditor`; `IndexingStatus` keys its render off status (incl. `error`) and self-refreshes every 10 minutes while in process. Config is removed from `SettingsView`.

**Tech Stack:** Next.js App Router (server + client components), React, TypeScript, Vitest with `renderToStaticMarkup` (node env — no jsdom; effects/clicks are not exercised in tests, so timer/click glue is verified via build + the extracted pure predicate).

**Spec:** `docs/superpowers/specs/2026-06-14-savings-config-colocation-design.md`

---

## File Structure

- **Create** `cmd/next-app/src/lib/roi/savings-status.ts` — pure status/view-state predicates.
- **Create** `cmd/next-app/src/lib/roi/savings-status.test.ts` — unit tests for the predicates.
- **Create** `cmd/next-app/src/components/site/savings/SavingsSettings.tsx` — disclosure wrapping the two config forms.
- **Create** `cmd/next-app/src/components/site/savings/SavingsSettings.test.tsx` — render test.
- **Modify** `cmd/next-app/src/components/site/savings/IndexingStatus.tsx` — status-keyed render + auto-refresh.
- **Create** `cmd/next-app/src/components/site/savings/IndexingStatus.test.tsx` — render test (the regression).
- **Modify** `cmd/next-app/src/components/site/savings/SavingsView.tsx` — switch on view state, render `SavingsSettings`.
- **Create** `cmd/next-app/src/components/site/savings/SavingsView.test.tsx` — smoke test for the regression.
- **Delete** `cmd/next-app/src/components/site/savings/SavingsEmptyState.tsx` — replaced by inline config.
- **Modify** `cmd/next-app/src/app/site/[id]/page.tsx` — pass `roiConfig`/`comparisonPlans` to `SavingsView`, drop from `SettingsView`.
- **Modify** `cmd/next-app/src/components/site/SettingsView.tsx` — remove the two config forms + their props.

---

## Task 1: Pure status / view-state module

**Files:**
- Create: `cmd/next-app/src/lib/roi/savings-status.ts`
- Test: `cmd/next-app/src/lib/roi/savings-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/roi/savings-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RollupBackfill } from '@/lib/db';
import type { RoiSummary } from './roi-service';
import { isBackfillInProcess, isTerminalBackfillError, selectSavingsViewState } from './savings-status';

const bf = (over: Partial<RollupBackfill>): RollupBackfill => ({
  site_id: 's1', status: 'pending', oldest_date: '2024-01-01', cursor_date: '2024-01-01',
  newest_date: '2024-06-01', days_done: 0, days_total: 100, genesis_anchored: false, last_error: null,
  ...over,
});

const summary = {} as RoiSummary;

describe('isBackfillInProcess', () => {
  it('is false when there is no backfill row', () => {
    expect(isBackfillInProcess(null)).toBe(false);
  });
  it('treats pending, running and error as in process', () => {
    expect(isBackfillInProcess(bf({ status: 'pending' }))).toBe(true);
    expect(isBackfillInProcess(bf({ status: 'running' }))).toBe(true);
    expect(isBackfillInProcess(bf({ status: 'error' }))).toBe(true);
  });
  it('is false once complete', () => {
    expect(isBackfillInProcess(bf({ status: 'complete' }))).toBe(false);
  });
});

describe('isTerminalBackfillError', () => {
  it('is false for non-error statuses', () => {
    expect(isTerminalBackfillError(bf({ status: 'running' }))).toBe(false);
    expect(isTerminalBackfillError(null)).toBe(false);
  });
  it('is false for a recoverable error below 5 attempts', () => {
    expect(isTerminalBackfillError(bf({ status: 'error', last_error: '[attempts=3] 529 overload' }))).toBe(false);
  });
  it('is true once attempts reach 5 (cron stops reclaiming)', () => {
    expect(isTerminalBackfillError(bf({ status: 'error', last_error: '[attempts=5] 529 overload' }))).toBe(true);
  });
  it('is false for an error with no attempt prefix', () => {
    expect(isTerminalBackfillError(bf({ status: 'error', last_error: 'boom' }))).toBe(false);
  });
});

describe('selectSavingsViewState', () => {
  it('returns in-process whenever the backfill is working, even on error', () => {
    expect(selectSavingsViewState(summary, bf({ status: 'error' }))).toBe('in-process');
    expect(selectSavingsViewState(null, bf({ status: 'running' }))).toBe('in-process');
  });
  it('returns setup when nothing is configured and nothing is running', () => {
    expect(selectSavingsViewState(null, null)).toBe('setup');
    expect(selectSavingsViewState(null, bf({ status: 'complete' }))).toBe('setup');
  });
  it('returns configured when a summary exists and nothing is running', () => {
    expect(selectSavingsViewState(summary, null)).toBe('configured');
    expect(selectSavingsViewState(summary, bf({ status: 'complete' }))).toBe('configured');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/roi/savings-status`
Expected: FAIL — cannot find module `./savings-status`.

- [ ] **Step 3: Write minimal implementation**

Create `cmd/next-app/src/lib/roi/savings-status.ts`:

```ts
import type { RollupBackfill } from '@/lib/db';
import type { RoiSummary } from './roi-service';

export type SavingsViewState = 'in-process' | 'setup' | 'configured';

/**
 * A backfill row that exists and has not completed is still being worked: the
 * index-history cron's claimNext() reclaims stale `running` and `error` rows
 * (up to 5 attempts). So `error` is in process, NOT "not started".
 */
export function isBackfillInProcess(backfill: RollupBackfill | null): boolean {
  return backfill != null && backfill.status !== 'complete';
}

/**
 * The cron stops reclaiming an `error` row once it reaches 5 attempts
 * (last_error like `[attempts=5]…`). At that point it is genuinely paused.
 */
export function isTerminalBackfillError(backfill: RollupBackfill | null): boolean {
  if (!backfill || backfill.status !== 'error') return false;
  const match = backfill.last_error?.match(/^\[attempts=(\d+)\]/);
  return match ? parseInt(match[1], 10) >= 5 : false;
}

export function selectSavingsViewState(
  summary: RoiSummary | null,
  backfill: RollupBackfill | null,
): SavingsViewState {
  if (isBackfillInProcess(backfill)) return 'in-process';
  if (!summary) return 'setup';
  return 'configured';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/roi/savings-status`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/savings-status.ts cmd/next-app/src/lib/roi/savings-status.test.ts
git commit -m "$(printf 'feat(roi): savings-status predicates (error = in process)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 2: IndexingStatus — status-keyed render + auto-refresh

**Files:**
- Modify: `cmd/next-app/src/components/site/savings/IndexingStatus.tsx`
- Test: `cmd/next-app/src/components/site/savings/IndexingStatus.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/components/site/savings/IndexingStatus.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RollupBackfill } from '@/lib/db';
import { IndexingStatus } from './IndexingStatus';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const bf = (over: Partial<RollupBackfill>): RollupBackfill => ({
  site_id: 's1', status: 'pending', oldest_date: '2024-01-01', cursor_date: '2024-03-01',
  newest_date: '2024-06-01', days_done: 50, days_total: 100, genesis_anchored: false, last_error: null,
  ...over,
});

describe('IndexingStatus', () => {
  it('shows progress and percent while running', () => {
    const html = renderToStaticMarkup(<IndexingStatus siteId="s1" backfill={bf({ status: 'running' })} />);
    expect(html).toContain('50%');
    expect(html).not.toContain('Index history');
  });

  it('shows the start CTA only when there is no backfill row', () => {
    const html = renderToStaticMarkup(<IndexingStatus siteId="s1" backfill={null} />);
    expect(html).toContain('Index history');
  });

  it('keeps the in-process card (no start button) on a recoverable error', () => {
    const html = renderToStaticMarkup(<IndexingStatus siteId="s1" backfill={bf({ status: 'error', last_error: '[attempts=2] 529 overload' })} />);
    expect(html).toMatch(/retry automatically/i);
    expect(html).not.toContain('Index history');
  });

  it('shows a paused message with no button on a terminal error', () => {
    const html = renderToStaticMarkup(<IndexingStatus siteId="s1" backfill={bf({ status: 'error', last_error: '[attempts=5] 529 overload' })} />);
    expect(html).toMatch(/resume later/i);
    expect(html).not.toContain('Index history');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/components/site/savings/IndexingStatus`
Expected: FAIL — the current component renders the "Index history" button for `error`, so the error-case assertions fail.

- [ ] **Step 3: Replace the implementation**

Replace the entire contents of `cmd/next-app/src/components/site/savings/IndexingStatus.tsx` with:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RollupBackfill } from '@/lib/db';
import { Card, CardContent } from '@/components/ui/Card';
import { isBackfillInProcess, isTerminalBackfillError } from '@/lib/roi/savings-status';

const REFRESH_MS = 10 * 60 * 1000; // 10 min: let progress advance without a manual reload

export function IndexingStatus({ siteId, backfill }: { siteId: string; backfill: RollupBackfill | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  const inProcess = isBackfillInProcess(backfill);

  useEffect(() => {
    if (!inProcess) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [inProcess, router]);

  if (inProcess && backfill) {
    const pct = backfill.days_total > 0 ? Math.round((backfill.days_done / backfill.days_total) * 100) : 0;
    const isError = backfill.status === 'error';
    const terminal = isTerminalBackfillError(backfill);
    return (
      <Card><CardContent className="py-6">
        <p className="font-semibold mb-2 text-foreground">Indexing your history… {pct}%</p>
        <div className="h-2 rounded-full bg-bg-muted overflow-hidden"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
        {!isError && (
          <p className="text-xs opacity-70 mt-2 text-foreground/80">Reconstructed back to {backfill.cursor_date}. This runs in the background; check back later.</p>
        )}
        {isError && !terminal && (
          <p className="text-xs mt-2 text-amber-700 dark:text-amber-300">Paused — will retry automatically. Reconstructed back to {backfill.cursor_date}.</p>
        )}
        {isError && terminal && (
          <p className="text-xs mt-2 text-amber-700 dark:text-amber-300">Reconstruction paused — it will resume later. Reconstructed back to {backfill.cursor_date}.</p>
        )}
      </CardContent></Card>
    );
  }

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/site/${siteId}/index-history`, { method: 'POST' });
      if (res.ok) setStarted(true);
    } finally { setBusy(false); }
  };

  return (
    <Card><CardContent className="py-8 text-center text-foreground">
      <p className="text-lg font-semibold mb-2">See your full payback history</p>
      <p className="opacity-70 mb-4 text-foreground/80">We can reconstruct your savings back to install. This runs in the background and may take a while.</p>
      {started
        ? <p className="text-sm text-primary">Indexing started — check back soon.</p>
        : <button onClick={start} disabled={busy} className="rounded-md bg-primary text-white px-4 py-2 disabled:opacity-60 hover:bg-primary/95 cursor-pointer font-medium text-sm transition-colors">{busy ? 'Starting…' : 'Index history'}</button>}
    </CardContent></Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/components/site/savings/IndexingStatus`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/savings/IndexingStatus.tsx cmd/next-app/src/components/site/savings/IndexingStatus.test.tsx
git commit -m "$(printf 'fix(roi): keep indexing takeover on error; start CTA only when unstarted\n\nThe start button reappeared whenever a backfill transiently flipped to\nerror (e.g. Tesla 529). Treat error as in process and self-refresh.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 3: SavingsSettings disclosure component

**Files:**
- Create: `cmd/next-app/src/components/site/savings/SavingsSettings.tsx`
- Test: `cmd/next-app/src/components/site/savings/SavingsSettings.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/components/site/savings/SavingsSettings.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SavingsSettings } from './SavingsSettings';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const props = { siteId: 's1', roiConfig: null, comparisonPlans: [], meteredPlanName: 'Standard' };

describe('SavingsSettings', () => {
  it('renders the config forms when defaultOpen is true', () => {
    const html = renderToStaticMarkup(<SavingsSettings {...props} defaultOpen />);
    expect(html).toContain('ROI / Savings');
    expect(html).toContain('Comparison plans');
  });

  it('hides the config forms when defaultOpen is false', () => {
    const html = renderToStaticMarkup(<SavingsSettings {...props} defaultOpen={false} />);
    expect(html).toContain('Savings settings');
    expect(html).not.toContain('ROI / Savings');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/components/site/savings/SavingsSettings`
Expected: FAIL — cannot find module `./SavingsSettings`.

- [ ] **Step 3: Write the component**

Create `cmd/next-app/src/components/site/savings/SavingsSettings.tsx`:

```tsx
'use client';
import { useState } from 'react';
import type { SiteRoiConfig } from '@/lib/db';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';
import { RoiConfigForm } from '@/components/site/RoiConfigForm';
import { ComparisonTariffEditor } from '@/components/site/ComparisonTariffEditor';

export function SavingsSettings({
  siteId,
  roiConfig,
  comparisonPlans,
  meteredPlanName,
  defaultOpen,
}: {
  siteId: string;
  roiConfig: SiteRoiConfig | null;
  comparisonPlans: ComparisonPlan[];
  meteredPlanName: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-sm font-medium text-foreground/80 hover:text-foreground cursor-pointer"
        aria-expanded={open}
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        ⚙️ Savings settings
      </button>
      {open && (
        <div className="space-y-6">
          <RoiConfigForm siteId={siteId} initial={roiConfig} />
          <ComparisonTariffEditor siteId={siteId} plans={comparisonPlans} meteredPlanName={meteredPlanName} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/components/site/savings/SavingsSettings`
Expected: PASS (both cases). (`RoiConfigForm` renders the title "ROI / Savings"; `ComparisonTariffEditor` renders "Comparison plans".)

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/savings/SavingsSettings.tsx cmd/next-app/src/components/site/savings/SavingsSettings.test.tsx
git commit -m "$(printf 'feat(roi): SavingsSettings disclosure wrapping ROI + comparison forms\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 4: SavingsView — switch on view state, render SavingsSettings

**Files:**
- Modify: `cmd/next-app/src/components/site/savings/SavingsView.tsx`
- Test: `cmd/next-app/src/components/site/savings/SavingsView.test.tsx`
- Delete: `cmd/next-app/src/components/site/savings/SavingsEmptyState.tsx`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/components/site/savings/SavingsView.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RollupBackfill } from '@/lib/db';
import { SavingsView } from './SavingsView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const bf = (over: Partial<RollupBackfill>): RollupBackfill => ({
  site_id: 's1', status: 'pending', oldest_date: '2024-01-01', cursor_date: '2024-03-01',
  newest_date: '2024-06-01', days_done: 40, days_total: 100, genesis_anchored: false, last_error: null,
  ...over,
});

const base = { siteId: 's1', roiConfig: null, comparisonPlans: [], meteredPlanName: 'Standard' };

describe('SavingsView', () => {
  it('shows the indexing takeover (no start CTA, no settings) on a recoverable error', () => {
    const html = renderToStaticMarkup(
      <SavingsView {...base} summary={null} backfill={bf({ status: 'error', last_error: '[attempts=2] 529' })} />,
    );
    expect(html).toMatch(/retry automatically/i);
    expect(html).not.toContain('Index history');
    expect(html).not.toContain('Savings settings');
  });

  it('shows expanded settings and the start CTA when nothing is set up', () => {
    const html = renderToStaticMarkup(<SavingsView {...base} summary={null} backfill={null} />);
    expect(html).toContain('Index history');
    expect(html).toContain('ROI / Savings');
  });

  it('shows expanded settings but no start CTA when a completed backfill exists without costs', () => {
    const html = renderToStaticMarkup(<SavingsView {...base} summary={null} backfill={bf({ status: 'complete' })} />);
    expect(html).toContain('ROI / Savings');
    expect(html).not.toContain('Index history');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/components/site/savings/SavingsView`
Expected: FAIL — current `SavingsView` renders `SavingsEmptyState` ("…in the Settings tab →") instead of inline settings, and shows the start button for `error`.

- [ ] **Step 3: Replace the implementation**

Replace the entire contents of `cmd/next-app/src/components/site/savings/SavingsView.tsx` with:

```tsx
import type { RoiSummary } from '@/lib/roi/roi-service';
import type { RollupBackfill, SiteRoiConfig } from '@/lib/db';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';
import { PaybackHero } from './PaybackHero';
import { ScenarioMatrix } from './ScenarioMatrix';
import { IndexingStatus } from './IndexingStatus';
import { SavingsSettings } from './SavingsSettings';
import { selectSavingsViewState } from '@/lib/roi/savings-status';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function SavingsView({
    summary,
    arbitrageSlot,
    chartSlot,
    siteId,
    backfill,
    roiConfig,
    comparisonPlans,
    fixedPlanName,
    meteredPlanName,
}: {
    summary: RoiSummary | null;
    arbitrageSlot?: React.ReactNode;
    chartSlot?: React.ReactNode;
    siteId: string;
    backfill: RollupBackfill | null;
    roiConfig: SiteRoiConfig | null;
    comparisonPlans: ComparisonPlan[];
    fixedPlanName?: string;
    meteredPlanName?: string;
}) {
    const state = selectSavingsViewState(summary, backfill);
    const settings = (defaultOpen: boolean) => (
        <SavingsSettings
            siteId={siteId}
            roiConfig={roiConfig}
            comparisonPlans={comparisonPlans}
            meteredPlanName={meteredPlanName ?? 'Standard'}
            defaultOpen={defaultOpen}
        />
    );

    // In-process backfill (pending | running | error): full-screen takeover.
    if (state === 'in-process') {
        return (
            <div className="space-y-6 max-w-5xl mx-auto">
                <IndexingStatus siteId={siteId} backfill={backfill} />
            </div>
        );
    }

    // Not configured: lead with config; offer to index history only if never started.
    if (state === 'setup') {
        return (
            <div className="space-y-6 max-w-5xl mx-auto">
                {settings(true)}
                {!backfill && <IndexingStatus siteId={siteId} backfill={backfill} />}
            </div>
        );
    }

    // Configured: savings output first, settings tucked away at the bottom.
    const showBackfillPrompt = !backfill || backfill.status !== 'complete';
    return (
        <div className="space-y-6 max-w-5xl mx-auto">
            {showBackfillPrompt && <IndexingStatus siteId={siteId} backfill={backfill} />}
            <PaybackHero summary={summary!} />
            {summary!.recommendation && (
                <div className="rounded-lg border border-green-600 bg-green-600/10 dark:border-green-500 dark:bg-green-950/20 p-3 text-sm">
                    💡 You&apos;re on TOU, but a flat plan looks ~{usd(summary!.recommendation.annualSaving)}/yr cheaper for your usage.
                    <span className="opacity-70"> (Estimate holds your behavior fixed; the real flat saving is likely a bit larger.)</span>
                </div>
            )}
            <ScenarioMatrix summary={summary!} fixedPlanName={fixedPlanName} meteredPlanName={meteredPlanName} />
            {summary!.actualPlan === 'fixed' && (
                <div className="rounded-lg border border-gray-200 dark:border-slate-800 bg-bg-muted/30 p-3 text-xs text-foreground/80 text-center">
                    ℹ️ You are on a fixed-rate plan. TOU comparison columns use your current flat rates (defining a custom TOU comparison plan is coming soon).
                </div>
            )}
            {chartSlot}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {summary!.components.filter(c => c.kind !== 'combined').map(c => (
                    <div key={c.kind} className="rounded-lg border border-gray-200 dark:border-slate-800 p-4 bg-bg-base">
                        <div className="font-semibold capitalize">{c.kind === 'solar' ? '☀️ Solar' : '🔋 Battery'}</div>
                        <div className="h-2 rounded-full bg-bg-muted my-2 overflow-hidden">
                            <div className="h-full bg-primary" style={{ width: `${Math.round(Math.min(1, c.pctRecovered) * 100)}%` }} />
                        </div>
                        <div className="text-xs opacity-80">{usd(c.savedToDate)} / {usd(c.cost)}{c.breakEvenDate && ` · ${c.breakEvenDate.slice(0, 4)}`}</div>
                    </div>
                ))}
            </div>
            {arbitrageSlot}
            {settings(false)}
        </div>
    );
}
```

- [ ] **Step 4: Delete the now-unused empty state**

```bash
git rm cmd/next-app/src/components/site/savings/SavingsEmptyState.tsx
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/components/site/savings/SavingsView`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/components/site/savings/SavingsView.tsx cmd/next-app/src/components/site/savings/SavingsView.test.tsx
git commit -m "$(printf 'feat(roi): co-locate savings config; switch SavingsView on view state\n\nLead with settings when unconfigured, tuck them away once configured,\nand keep the takeover during an in-process (incl. error) backfill.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 5: Wire page.tsx and clean up SettingsView

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx:375-389`
- Modify: `cmd/next-app/src/components/site/SettingsView.tsx`

- [ ] **Step 1: Pass new props to SavingsView in page.tsx**

In `cmd/next-app/src/app/site/[id]/page.tsx`, replace the `savingsSlot` block (currently lines ~375-385) with:

```tsx
                savingsSlot={
                    <SavingsView
                        summary={roiSummary}
                        siteId={finalSite.id}
                        backfill={backfill}
                        roiConfig={roiConfig}
                        comparisonPlans={comparisonPlans}
                        arbitrageSlot={arbitrage ? <ArbitragePanel summary={arbitrage} /> : null}
                        chartSlot={savingsSeries && roiConfig ? <SavingsChart series={savingsSeries} systemCost={(roiConfig.solar_cost ?? 0) + (roiConfig.battery_cost ?? 0)} /> : null}
                        fixedPlanName={fixedPlanName}
                        meteredPlanName={finalSite.tariffs?.[0]?.name ?? 'Your plan'}
                    />
                }
```

- [ ] **Step 2: Drop the moved props from SettingsView in page.tsx**

In the same file, replace the `settingsSlot` block (currently line ~388-389) with:

```tsx
                settingsSlot={
                    <SettingsView site={finalSite} installation={installation} />
                }
```

- [ ] **Step 3: Remove the config forms and props from SettingsView**

In `cmd/next-app/src/components/site/SettingsView.tsx`:

Remove these two imports (lines ~21-23):

```tsx
import { RoiConfigForm } from './RoiConfigForm';
import { ComparisonTariffEditor } from './ComparisonTariffEditor';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';
```

Change the `SiteRoiConfig` import on line ~20 — it is no longer used here. Replace:

```tsx
import { SiteWithTariffs, TrmnlInstallation, SiteRoiConfig } from '@/lib/db';
```

with:

```tsx
import { SiteWithTariffs, TrmnlInstallation } from '@/lib/db';
```

Replace the props interface (lines ~25-30):

```tsx
interface SettingsViewProps {
    site: SiteWithTariffs;
    installation: TrmnlInstallation | undefined;
    roiConfig?: SiteRoiConfig | null;
    comparisonPlans?: ComparisonPlan[];
}
```

with:

```tsx
interface SettingsViewProps {
    site: SiteWithTariffs;
    installation: TrmnlInstallation | undefined;
}
```

Update the destructure (line ~94):

```tsx
export function SettingsView({ site, installation, roiConfig, comparisonPlans }: SettingsViewProps) {
```

to:

```tsx
export function SettingsView({ site, installation }: SettingsViewProps) {
```

Remove the two renders (lines ~324-326):

```tsx
            <RoiConfigForm siteId={site.id} initial={roiConfig ?? null} />

            <ComparisonTariffEditor siteId={site.id} plans={comparisonPlans ?? []} meteredPlanName={site.tariffs?.[0]?.name ?? 'Standard'} />
```

(Leave the surrounding `<TariffList … />` in place.)

- [ ] **Step 4: Verify types and lint**

Run: `cd cmd/next-app && npm run lint`
Expected: PASS, no unused-variable or missing-prop errors for the touched files.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/site/[id]/page.tsx cmd/next-app/src/components/site/SettingsView.tsx
git commit -m "$(printf 'feat(roi): move savings config off Settings tab onto Savings tab\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd cmd/next-app && npm test`
Expected: PASS — all suites green, including the four new/modified files.

- [ ] **Step 2: Lint**

Run: `cd cmd/next-app && npm run lint`
Expected: PASS, no errors.

- [ ] **Step 3: Production build**

Run: `cd cmd/next-app && npm run build`
Expected: build completes with no type errors (confirms `SettingsView` callers, the deleted `SavingsEmptyState`, and the new `SavingsView` props all line up).

- [ ] **Step 4: Manual smoke (optional, uses live/billable Tesla — use the Harrison site)**

Run: `cd cmd/next-app && npm run dev` and open `/site/<id>?view=savings`. Confirm:
- Unconfigured site → settings expanded + "Index history" CTA.
- Configured site → savings output first, "⚙️ Savings settings" collapsed at the bottom (expands on click).
- A site mid-backfill → progress takeover; no "Index history" button appears even if the row is in `error`.
```
