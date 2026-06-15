# Mobile Site Tab Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On phones, collapse inactive site tabs to icon-only while the active tab keeps its label, eliminating horizontal overflow — desktop appearance unchanged.

**Architecture:** Extract a tiny pure helper (`tabLabelClass`) that maps a tab id + the active tab id to the Tailwind visibility classes for that tab's text label. `SiteTabs.tsx` wraps each tab's text in a `<span>` using that helper and adds an `aria-label` to each trigger. `Tabs.tsx` is untouched (it already forwards `...props` to the button).

**Tech Stack:** Next.js (App Router), React, Tailwind CSS, Vitest with `react-dom/server` `renderToStaticMarkup` (node env, no DOM library).

---

## File Structure

- `cmd/next-app/src/components/site/SiteTabs.tsx` — **Modify.** Add and use `tabLabelClass`; wrap each label in a span; add `aria-label` per trigger.
- `cmd/next-app/src/components/site/SiteTabs.test.tsx` — **Create.** Unit tests for `tabLabelClass`.

`Tabs.tsx` requires no changes.

---

## Task 1: `tabLabelClass` helper (pure, TDD)

The new visibility logic lives in one pure, exported function so it can be tested without mocking `next/navigation`. On mobile, only the active tab's label is visible; inactive labels are `sr-only` (present for screen readers) and revealed at `md` and up.

**Files:**
- Modify: `cmd/next-app/src/components/site/SiteTabs.tsx`
- Test: `cmd/next-app/src/components/site/SiteTabs.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/components/site/SiteTabs.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { tabLabelClass } from './SiteTabs';

describe('tabLabelClass', () => {
    it('shows the active tab label on all viewports', () => {
        expect(tabLabelClass('bill', 'bill')).toBe('inline');
    });

    it('hides inactive tab labels on mobile but shows them on desktop', () => {
        expect(tabLabelClass('history', 'bill')).toBe('sr-only md:not-sr-only');
    });

    it('treats each tab independently of the others', () => {
        expect(tabLabelClass('settings', 'savings')).toBe('sr-only md:not-sr-only');
        expect(tabLabelClass('savings', 'savings')).toBe('inline');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/components/site/SiteTabs.test.tsx`
Expected: FAIL — `tabLabelClass` is not exported from `./SiteTabs`.

- [ ] **Step 3: Add the helper**

In `cmd/next-app/src/components/site/SiteTabs.tsx`, add the exported helper near the top (after the `TabId` type, before the `SiteTabsProps` interface):

```tsx
export function tabLabelClass(tabId: TabId, activeTab: TabId): string {
    return tabId === activeTab ? 'inline' : 'sr-only md:not-sr-only';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/components/site/SiteTabs.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/SiteTabs.tsx cmd/next-app/src/components/site/SiteTabs.test.tsx
git commit -m "Add tabLabelClass helper for mobile tab label visibility"
```

---

## Task 2: Apply helper + aria-labels in the tab bar

Wrap each trigger's text label in a `<span>` using `tabLabelClass`, and add an `aria-label` so each button keeps a stable accessible name when its visible label is collapsed on mobile.

**Files:**
- Modify: `cmd/next-app/src/components/site/SiteTabs.tsx:68-92` (the four `TabsTrigger` elements in the top `TabsList`)

- [ ] **Step 1: Update the History trigger**

Replace the History `TabsTrigger` (currently the icon `<svg>` followed by the bare text `History`) so the text is wrapped and an `aria-label` is added. Keep the existing `<svg>` icon exactly as-is:

```tsx
<TabsTrigger value="history" aria-label="History" className="flex items-center gap-2">
    {/* existing History <svg> unchanged */}
    <span className={tabLabelClass('history', activeTab)}>History</span>
</TabsTrigger>
```

- [ ] **Step 2: Update the Estimated Bill trigger**

```tsx
<TabsTrigger value="bill" aria-label="Estimated Bill" className="flex items-center gap-2">
    {/* existing Estimated Bill <svg> unchanged */}
    <span className={tabLabelClass('bill', activeTab)}>Estimated Bill</span>
</TabsTrigger>
```

- [ ] **Step 3: Update the Savings trigger**

```tsx
<TabsTrigger value="savings" aria-label="Savings" className="flex items-center gap-2">
    {/* existing Savings <svg> unchanged */}
    <span className={tabLabelClass('savings', activeTab)}>Savings</span>
</TabsTrigger>
```

- [ ] **Step 4: Update the Settings trigger**

```tsx
<TabsTrigger value="settings" aria-label="Settings" className="flex items-center gap-2">
    {/* existing Settings <svg> unchanged */}
    <span className={tabLabelClass('settings', activeTab)}>Settings</span>
</TabsTrigger>
```

Note: `aria-label` passes straight through — `Tabs.tsx`'s `TabsTrigger` spreads `...props` onto the `<button>`. No change to `Tabs.tsx`.

- [ ] **Step 5: Verify lint passes**

Run: `cd cmd/next-app && npm run lint`
Expected: PASS, no new warnings/errors.

- [ ] **Step 6: Verify the build passes**

Run: `cd cmd/next-app && npm run build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/components/site/SiteTabs.tsx
git commit -m "Collapse inactive site tabs to icons on mobile"
```

---

## Manual Verification (after both tasks)

1. `cd cmd/next-app && npm run dev`, open a site dashboard.
2. Narrow the viewport to ~340–390px (phone width):
   - All four tab icons visible, no horizontal scroll.
   - Only the active tab shows a text label.
   - Switching tabs moves the visible label to the newly active tab (instant snap).
3. Widen to `md`+ (≥768px): all four tabs show icon + full label, identical to current behavior.
4. Screen reader / accessibility tree: each tab button is announced by its name even when its label is visually collapsed.

---

## Self-Review Notes

- **Spec coverage:** mobile collapse (Task 1+2), desktop unchanged (`md:not-sr-only` + untouched desktop classes), accessibility via `sr-only` + `aria-label` (Task 2), instant snap (no animation added), `Tabs.tsx` untouched, lint/build (Task 2 steps 5–6) — all covered.
- **Placeholder scan:** none.
- **Type consistency:** `tabLabelClass(tabId: TabId, activeTab: TabId)` used consistently; `activeTab` is the existing variable in `SiteTabs` (`SiteTabs.tsx:28`). `TabId` already defined at `SiteTabs.tsx:7`.
