# Mobile Site Tab Bar — Collapse Inactive Tabs to Icons

**Date:** 2026-06-15
**Status:** Approved
**Area:** `cmd/next-app/src/components/site/SiteTabs.tsx`

## Problem

The site dashboard tab bar (History, Estimated Bill, Savings, Settings) renders each
tab as a pill with an icon + full text label inside a single rounded container. On
phones the four full-label pills are wider than the viewport, so the bar overflows and
relies on `overflow-x-auto` (horizontal scroll), which looks cut off and awkward.

## Goal

Make the tab bar fit comfortably on a typical phone (~340px wide) without horizontal
scroll, while leaving the desktop appearance unchanged.

## Approach

On mobile, collapse inactive tabs to **icon only**; the active tab keeps its **icon +
label**. On desktop (`md` and up), every tab shows icon + full label exactly as today.

This was chosen over a bottom nav bar (larger structural change), shortened labels
(still tight on the narrowest phones), and a dropdown (hides options behind a tap). It
solves the width problem with the smallest, most contained change and no impact on the
desktop design.

## Behavior

- **Mobile (`< md`):**
  - Active tab: icon + label.
  - Inactive tabs: icon only (label visually hidden, still present for screen readers).
  - No horizontal scroll under normal conditions.
- **Desktop (`md` and up):** unchanged — all four tabs show icon + full label.
- **Tab switch:** instant snap. Pills resize as labels appear/disappear; no width
  animation (avoids layout-animation jank). Existing `transition-colors` is retained.

## Implementation

All changes are confined to `SiteTabs.tsx`. `Tabs.tsx` stays generic — it already
spreads `...props` onto the underlying `<button>`, so `aria-label` passes through
without modification.

For each `TabsTrigger`:

1. Wrap the text label in a `<span>` whose visibility depends on whether that tab is
   the active tab (the parent already knows `activeTab`):
   - Active tab: label always visible (e.g. `inline`).
   - Inactive tab: `sr-only md:not-sr-only` — visually hidden on mobile, in the
     accessibility tree, fully shown on desktop.
2. Add `aria-label={<tab name>}` to the trigger so the button is always announced
   correctly even when its visible text is collapsed.

Keep `overflow-x-auto` on `TabsList` as a harmless safety net.

### Active-state visibility helper

The label-visibility class is derived from `activeTab` in the parent. A small helper or
inline expression maps each tab to its class:

```
labelClass(tabId) = tabId === activeTab ? 'inline' : 'sr-only md:not-sr-only'
```

## Accessibility

- Inactive labels use `sr-only` (not `hidden`), so they remain in the accessibility tree.
- Each trigger carries an `aria-label`, guaranteeing a stable accessible name regardless
  of visual label state.
- `aria-selected` continues to work via the existing `isActive` logic in `Tabs.tsx`.

## Out of Scope

- Default-tab logic, `localStorage` tab persistence (`pwusage_last_site_tab`).
- Breadcrumb layout.
- Desktop tab appearance.
- Any change to `Tabs.tsx`.

## Verification

- Manual: view a site dashboard at mobile width (~340–390px) — all four tabs visible,
  no horizontal scroll, only the active tab labeled; switching tabs moves the label.
- Manual: view at `md`+ width — unchanged from current (all labels shown).
- `npm run lint` and `npm run build` pass.
