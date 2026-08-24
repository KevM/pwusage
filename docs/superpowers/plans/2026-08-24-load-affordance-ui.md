# Load Affordance UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer "can I run this load right now?" — as a glyph in the live status header on every page, and as an interactive cost widget at the top of the Live view.

**Architecture:** One JSON-configured table of load profiles and one pure pricing module (`load-affordance.ts`) feed both surfaces, so the header glyph and the Live widget cannot disagree. The header's headroom number is derived from bucketed rows the API route already has in memory plus a once-per-day cached cycle rollup, adding no per-poll DB egress.

**Tech Stack:** Next.js App Router (React 19, Server Components), TypeScript, Tailwind (semantic CSS-variable tokens), Vitest (node environment), node-postgres.

**Spec:** `docs/superpowers/specs/2026-08-24-load-affordance-ui-design.md`

## Global Constraints

- Working directory for all commands: `cmd/next-app`. All paths below are relative to `cmd/next-app` unless stated otherwise.
- Tests are co-located: `foo.test.ts` next to `foo.ts`.
- Vitest runs in the **node** environment — there is no jsdom. Component tests use `renderToStaticMarkup` from `react-dom/server` (see `src/components/site/live/ConfirmHoldModal.test.tsx` for the established pattern). Do not add jsdom or `@testing-library/react`.
- Tailwind: use the semantic token classes (`bg-bg-base`, `text-foreground`) rather than `bg-white` plus `dark:` overrides, which fail in dark mode. Existing colour-role pairs (`text-green-700 dark:text-green-400`) are fine and already used by `getPeriodCardDisplay`.
- **No database migration.** No new tables, no new columns. Load profiles live in a JSON file in the repo.
- **TRMNL output must not change.** New fields on `LoadTimingPeriod` are additive; the existing TRMNL tests passing unchanged is the check that this held.
- `npm run lint` and `npm run build` must both pass before the work is considered done.
- Energy units: `EnergyData.grid_power` is **Wh per 5-minute sample**, positive when importing. Net export in kWh is `-(sum of Wh) / 1000`. `getBucketedEnergyData` returns `AVG(grid_power)` per 15-minute bin, so a full bin's energy is `avg * 3`.
- Money is stored and computed in **dollars** (e.g. `buy_rate: 0.48`), not cents.

---

### Task 1: Load profiles configuration and loader

**Files:**
- Create: `src/lib/load-profiles.json`
- Create: `src/lib/load-profiles.ts`
- Test: `src/lib/load-profiles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type LoadGlyph = 'car' | 'appliance' | 'small'`; `interface LoadProfile { id: string; label: string; kwh: number; headroomKwh: number; glyph: LoadGlyph }`; `const LOAD_PROFILES: LoadProfile[]` (sorted by `headroomKwh` descending); `const MAX_PROFILE_KWH: number`; `function parseLoadProfiles(raw: unknown): LoadProfile[]`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/load-profiles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LOAD_PROFILES, MAX_PROFILE_KWH, parseLoadProfiles } from './load-profiles';

const valid = {
    profiles: [
        { id: 'a', label: 'A', kwh: 10, headroomKwh: 20, glyph: 'car' },
        { id: 'b', label: 'B', kwh: 5, headroomKwh: 40, glyph: 'appliance' },
    ],
};

describe('parseLoadProfiles', () => {
    it('sorts profiles by headroomKwh descending', () => {
        const parsed = parseLoadProfiles(valid);
        expect(parsed.map(p => p.id)).toEqual(['b', 'a']);
    });

    it('accepts two profiles sharing a glyph', () => {
        const parsed = parseLoadProfiles({
            profiles: [
                { id: 'big', label: 'Big car', kwh: 100, headroomKwh: 160, glyph: 'car' },
                { id: 'small', label: 'Little car', kwh: 60, headroomKwh: 100, glyph: 'car' },
            ],
        });
        expect(parsed).toHaveLength(2);
        expect(parsed.every(p => p.glyph === 'car')).toBe(true);
    });

    it('rejects headroomKwh below kwh', () => {
        expect(() => parseLoadProfiles({
            profiles: [{ id: 'a', label: 'A', kwh: 50, headroomKwh: 10, glyph: 'car' }],
        })).toThrow(/headroomKwh/);
    });

    it('rejects a duplicate id', () => {
        expect(() => parseLoadProfiles({
            profiles: [
                { id: 'a', label: 'A', kwh: 5, headroomKwh: 5, glyph: 'small' },
                { id: 'a', label: 'B', kwh: 6, headroomKwh: 6, glyph: 'small' },
            ],
        })).toThrow(/duplicate/i);
    });

    it('rejects a non-positive kwh', () => {
        expect(() => parseLoadProfiles({
            profiles: [{ id: 'a', label: 'A', kwh: 0, headroomKwh: 5, glyph: 'small' }],
        })).toThrow(/kwh/);
    });

    it('rejects an unknown glyph', () => {
        expect(() => parseLoadProfiles({
            profiles: [{ id: 'a', label: 'A', kwh: 5, headroomKwh: 5, glyph: 'rocket' }],
        })).toThrow(/glyph/);
    });

    it('rejects a missing label', () => {
        expect(() => parseLoadProfiles({
            profiles: [{ id: 'a', kwh: 5, headroomKwh: 5, glyph: 'small' }],
        })).toThrow(/label/);
    });
});

describe('shipped profiles', () => {
    it('loads and is sorted descending by headroomKwh', () => {
        expect(LOAD_PROFILES.length).toBeGreaterThan(0);
        const headrooms = LOAD_PROFILES.map(p => p.headroomKwh);
        expect([...headrooms].sort((a, b) => b - a)).toEqual(headrooms);
    });

    it('exposes the largest load size as MAX_PROFILE_KWH', () => {
        expect(MAX_PROFILE_KWH).toBe(Math.max(...LOAD_PROFILES.map(p => p.kwh)));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/load-profiles.test.ts`
Expected: FAIL — cannot resolve `./load-profiles`.

- [ ] **Step 3: Write the JSON data file**

Create `src/lib/load-profiles.json`:

```json
{
  "profiles": [
    { "id": "car-large", "label": "Big car", "kwh": 100, "headroomKwh": 160, "glyph": "car" },
    { "id": "car-small", "label": "Little car", "kwh": 60, "headroomKwh": 100, "glyph": "car" },
    { "id": "laundry", "label": "Laundry", "kwh": 8, "headroomKwh": 20, "glyph": "appliance" },
    { "id": "dishwasher", "label": "Dishwasher", "kwh": 5, "headroomKwh": 5, "glyph": "small" }
  ]
}
```

- [ ] **Step 4: Write the loader**

Create `src/lib/load-profiles.ts`:

```ts
import raw from './load-profiles.json';

export type LoadGlyph = 'car' | 'appliance' | 'small';

const GLYPHS: readonly LoadGlyph[] = ['car', 'appliance', 'small'];

export interface LoadProfile {
    id: string;
    label: string;
    kwh: number;          // energy the load consumes
    headroomKwh: number;  // surplus needed before the glyph green-lights it
    glyph: LoadGlyph;
}

/**
 * Validates and normalises the profile table. Throws on a malformed file so a
 * bad edit fails the build instead of rendering a broken UI.
 *
 * Note what is deliberately NOT validated: glyph uniqueness. Several profiles
 * sharing one glyph (a big car and a little car) is the expected case.
 */
export function parseLoadProfiles(rawInput: unknown): LoadProfile[] {
    const profiles = (rawInput as { profiles?: unknown })?.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) {
        throw new Error('load-profiles: "profiles" must be a non-empty array');
    }

    const seen = new Set<string>();
    const parsed = profiles.map((entry, index) => {
        const p = entry as Partial<LoadProfile>;
        const where = `load-profiles[${index}]`;

        if (typeof p.id !== 'string' || p.id.length === 0) {
            throw new Error(`${where}: id must be a non-empty string`);
        }
        if (seen.has(p.id)) {
            throw new Error(`${where}: duplicate id "${p.id}"`);
        }
        seen.add(p.id);

        if (typeof p.label !== 'string' || p.label.length === 0) {
            throw new Error(`${where}: label must be a non-empty string`);
        }
        if (typeof p.kwh !== 'number' || !(p.kwh > 0)) {
            throw new Error(`${where}: kwh must be a positive number`);
        }
        if (typeof p.headroomKwh !== 'number' || !(p.headroomKwh > 0)) {
            throw new Error(`${where}: headroomKwh must be a positive number`);
        }
        if (p.headroomKwh < p.kwh) {
            throw new Error(`${where}: headroomKwh (${p.headroomKwh}) must be >= kwh (${p.kwh})`);
        }
        if (!GLYPHS.includes(p.glyph as LoadGlyph)) {
            throw new Error(`${where}: glyph must be one of ${GLYPHS.join(', ')}`);
        }

        return { id: p.id, label: p.label, kwh: p.kwh, headroomKwh: p.headroomKwh, glyph: p.glyph as LoadGlyph };
    });

    return parsed.sort((a, b) => b.headroomKwh - a.headroomKwh);
}

export const LOAD_PROFILES: LoadProfile[] = parseLoadProfiles(raw);

export const MAX_PROFILE_KWH: number = Math.max(...LOAD_PROFILES.map(p => p.kwh));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/lib/load-profiles.test.ts`
Expected: PASS, all 9 tests.

If TypeScript complains about importing JSON, confirm `resolveJsonModule` is enabled in `tsconfig.json`; Next.js enables it by default. If it is missing, add `"resolveJsonModule": true` to `compilerOptions`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/load-profiles.json src/lib/load-profiles.ts src/lib/load-profiles.test.ts
git commit -m "feat(loads): add data-driven load profile table and validating loader"
```

---

### Task 2: Load affordance pricing core

**Files:**
- Create: `src/lib/load-affordance.ts`
- Test: `src/lib/load-affordance.test.ts`

**Interfaces:**
- Consumes: `LoadProfile`, `LoadGlyph`, `LOAD_PROFILES` from Task 1.
- Produces: `interface PeriodPricing { surplusKwh: number; buyRate: number; sellRate: number }`; `type LoadVerdict = 'covered' | 'tight' | 'partial' | 'bought'`; `interface LoadCost { total: number; coveredKwh: number; boughtKwh: number; verdict: LoadVerdict }`; `function costToRun(loadKwh: number, pricing: PeriodPricing, headroomKwh?: number): LoadCost`; `function profileForHeadroom(surplusKwh: number, profiles?: LoadProfile[]): LoadProfile | null`; `function glyphForHeadroom(surplusKwh: number, profiles?: LoadProfile[]): LoadGlyph | null`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/load-affordance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { costToRun, glyphForHeadroom, profileForHeadroom } from './load-affordance';
import type { LoadProfile } from './load-profiles';

const peak = { surplusKwh: 10, buyRate: 0.48, sellRate: 0.12 };
const offPeak = { surplusKwh: 120, buyRate: 0.15, sellRate: 0.03 };

const fixture: LoadProfile[] = [
    { id: 'big', label: 'Big car', kwh: 100, headroomKwh: 160, glyph: 'car' },
    { id: 'small', label: 'Little car', kwh: 60, headroomKwh: 100, glyph: 'car' },
    { id: 'laundry', label: 'Laundry', kwh: 8, headroomKwh: 20, glyph: 'appliance' },
];

describe('costToRun', () => {
    it('prices a car charge that outruns the surplus at the buy rate', () => {
        const c = costToRun(60, peak);
        expect(c.coveredKwh).toBe(10);
        expect(c.boughtKwh).toBe(50);
        expect(c.total).toBeCloseTo(25.2, 6);
        expect(c.verdict).toBe('partial');
    });

    it('prices the same charge entirely at the sell rate when surplus is ample', () => {
        const c = costToRun(60, offPeak);
        expect(c.boughtKwh).toBe(0);
        expect(c.total).toBeCloseTo(1.8, 6);
        expect(c.verdict).toBe('covered');
    });

    it('reports tight when the load is affordable but eats the headroom', () => {
        const tight = costToRun(60, { surplusKwh: 70, buyRate: 0.48, sellRate: 0.12 }, 100);
        const covered = costToRun(60, { surplusKwh: 120, buyRate: 0.48, sellRate: 0.12 }, 100);
        expect(tight.verdict).toBe('tight');
        expect(covered.verdict).toBe('covered');
        // The whole point: identical dollars, different judgement.
        expect(tight.total).toBeCloseTo(covered.total, 6);
    });

    it('collapses tight into covered when no headroom is supplied', () => {
        const c = costToRun(60, { surplusKwh: 70, buyRate: 0.48, sellRate: 0.12 });
        expect(c.verdict).toBe('covered');
    });

    it('prices everything at the buy rate in deficit', () => {
        const c = costToRun(5, { surplusKwh: -20, buyRate: 0.48, sellRate: 0.12 });
        expect(c.coveredKwh).toBe(0);
        expect(c.boughtKwh).toBe(5);
        expect(c.total).toBeCloseTo(2.4, 6);
        expect(c.verdict).toBe('bought');
    });

    it('treats a zero surplus as bought', () => {
        expect(costToRun(5, { surplusKwh: 0, buyRate: 0.48, sellRate: 0.12 }).verdict).toBe('bought');
    });

    it('handles a zero sell rate without inventing cost', () => {
        const c = costToRun(5, { surplusKwh: 50, buyRate: 0.48, sellRate: 0 });
        expect(c.total).toBe(0);
    });
});

describe('profileForHeadroom', () => {
    it('selects the largest profile the surplus clears', () => {
        expect(profileForHeadroom(200, fixture)?.id).toBe('big');
        expect(profileForHeadroom(120, fixture)?.id).toBe('small');
        expect(profileForHeadroom(25, fixture)?.id).toBe('laundry');
    });

    it('resolves distinct profiles where the glyph is identical', () => {
        expect(profileForHeadroom(200, fixture)?.label).toBe('Big car');
        expect(profileForHeadroom(120, fixture)?.label).toBe('Little car');
        expect(glyphForHeadroom(200, fixture)).toBe('car');
        expect(glyphForHeadroom(120, fixture)).toBe('car');
    });

    it('is inclusive at the threshold', () => {
        expect(profileForHeadroom(160, fixture)?.id).toBe('big');
        expect(profileForHeadroom(159.9, fixture)?.id).toBe('small');
    });

    it('returns null below the smallest threshold', () => {
        expect(profileForHeadroom(19, fixture)).toBeNull();
        expect(profileForHeadroom(0, fixture)).toBeNull();
        expect(profileForHeadroom(-30, fixture)).toBeNull();
        expect(glyphForHeadroom(-30, fixture)).toBeNull();
    });

    it('returns null for an empty profile table', () => {
        expect(profileForHeadroom(500, [])).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/load-affordance.test.ts`
Expected: FAIL — cannot resolve `./load-affordance`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/load-affordance.ts`:

```ts
import { LOAD_PROFILES, type LoadGlyph, type LoadProfile } from './load-profiles';

export interface PeriodPricing {
    surplusKwh: number;   // cycle net export for the period; negative means deficit
    buyRate: number;
    sellRate: number;
}

export type LoadVerdict = 'covered' | 'tight' | 'partial' | 'bought';

export interface LoadCost {
    total: number;
    coveredKwh: number;   // priced at the sell rate
    boughtKwh: number;    // priced at the buy rate
    verdict: LoadVerdict;
}

/**
 * What a load of `loadKwh` costs in a period right now.
 *
 * The portion the period's banked surplus absorbs is priced at the sell rate
 * (you give up an export); the remainder is priced at the buy rate. That cliff
 * is why a 60 kWh car charge can cost $25 in Peak and $1.80 in Off-peak.
 *
 * `headroomKwh` only affects the verdict, never the dollars: a load can be
 * entirely sell-rate priced and still drain the buffer that has to last the
 * rest of the cycle. Omit it (a custom slider amount) and `tight` collapses
 * into `covered`.
 */
export function costToRun(loadKwh: number, pricing: PeriodPricing, headroomKwh?: number): LoadCost {
    const surplus = Math.max(pricing.surplusKwh, 0);
    const coveredKwh = Math.min(loadKwh, surplus);
    const boughtKwh = loadKwh - coveredKwh;
    const total = coveredKwh * pricing.sellRate + boughtKwh * pricing.buyRate;

    let verdict: LoadVerdict;
    if (coveredKwh === 0) {
        verdict = 'bought';
    } else if (boughtKwh > 0) {
        verdict = 'partial';
    } else if (headroomKwh !== undefined && pricing.surplusKwh < headroomKwh) {
        verdict = 'tight';
    } else {
        verdict = 'covered';
    }

    return { total, coveredKwh, boughtKwh, verdict };
}

/**
 * The largest load the surplus comfortably affords. `profiles` is pre-sorted
 * by headroom descending, so the first match wins.
 */
export function profileForHeadroom(
    surplusKwh: number,
    profiles: LoadProfile[] = LOAD_PROFILES
): LoadProfile | null {
    return profiles.find(p => surplusKwh >= p.headroomKwh) ?? null;
}

export function glyphForHeadroom(
    surplusKwh: number,
    profiles: LoadProfile[] = LOAD_PROFILES
): LoadGlyph | null {
    return profileForHeadroom(surplusKwh, profiles)?.glyph ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/load-affordance.test.ts`
Expected: PASS, all 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/load-affordance.ts src/lib/load-affordance.test.ts
git commit -m "feat(loads): add load affordance pricing core"
```

---

### Task 3: Expose buy and sell rates on LoadTimingPeriod

**Files:**
- Modify: `src/lib/load-timing.ts` (the `LoadTimingPeriod` interface near line 19, and the `periods` map near the end of `computeLoadTiming`)
- Test: `src/lib/load-timing.test.ts` (existing file — add a case; if it does not exist, create it)

**Interfaces:**
- Consumes: nothing new.
- Produces: `LoadTimingPeriod` gains `buyRate: number` and `sellRate: number`. Task 5 depends on both.

The widget cannot price a load without both sides of the cliff, and `LoadTimingPeriod` currently exposes only `marginalCost` (whichever rate is in force). The values already exist on the grouped rows inside `computeLoadTiming` — this only surfaces them.

- [ ] **Step 1: Read the existing test file**

Run: `cat src/lib/load-timing.test.ts`

Note the existing fixture-building helpers and reuse them rather than inventing new ones. If the file does not exist, create it and build a `Schedule` fixture modelled on `src/lib/next-cheaper-period.test.ts`.

- [ ] **Step 2: Write the failing test**

Add to `src/lib/load-timing.test.ts`, inside the existing top-level `describe`:

```ts
it('exposes both sides of the price cliff on every period', () => {
    // Reuse whichever fixture the surrounding tests use to build a view with
    // at least one period holding a surplus.
    const view = buildViewFixture();

    for (const p of view.periods) {
        expect(typeof p.buyRate).toBe('number');
        expect(typeof p.sellRate).toBe('number');
    }

    // marginalCost is whichever rate is currently in force, so it must equal
    // one of the two exposed rates rather than being a third number.
    for (const p of view.periods) {
        if (p.marginalCost === null) continue;
        expect([p.buyRate, p.sellRate]).toContain(p.marginalCost);
    }
});
```

Replace `buildViewFixture()` with the actual fixture construction used by the neighbouring tests in that file.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/lib/load-timing.test.ts`
Expected: FAIL — `expect(typeof p.buyRate).toBe('number')` receives `"undefined"`.

- [ ] **Step 4: Add the fields to the interface**

In `src/lib/load-timing.ts`, extend `LoadTimingPeriod`:

```ts
export interface LoadTimingPeriod {
    name: string;
    marginalCost: number | null;
    basis: MarginalCostBasis;
    cycleNetExportKwh: number;
    isActive: boolean;
    nextStartPhrase: string | null;
    buyRate: number;
    sellRate: number;
}
```

- [ ] **Step 5: Populate them in the periods map**

In `computeLoadTiming`, the `periods` map currently reads:

```ts
        return { name, marginalCost, basis, cycleNetExportKwh, isActive, nextStartPhrase };
```

Change it to:

```ts
        return {
            name, marginalCost, basis, cycleNetExportKwh, isActive, nextStartPhrase,
            buyRate: u.buyRate ?? 0,
            sellRate: u.sellRate ?? 0
        };
```

`u` is the grouped `UsageData` already in scope in that callback; its `buyRate` / `sellRate` were resolved to the current season's rates earlier in the function.

- [ ] **Step 6: Run the full test suite to verify nothing regressed**

Run: `npm test`
Expected: PASS. In particular the TRMNL tests must pass **unchanged** — that is the check that this addition really is additive and the e-ink output did not move.

- [ ] **Step 7: Commit**

```bash
git add src/lib/load-timing.ts src/lib/load-timing.test.ts
git commit -m "feat(load-timing): expose buy and sell rates on each period"
```

---

### Task 4: Move the Load timing card to the top of the Live view

**Files:**
- Modify: `src/components/site/live/LiveDetailView.tsx:50-100`
- Test: `src/components/site/live/LiveDetailView.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. Pure reordering.

- [ ] **Step 1: Write the failing test**

Create `src/components/site/live/LiveDetailView.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveDetailView } from './LiveDetailView';

function renderView() {
    return renderToStaticMarkup(
        <LiveDetailView
            siteId="123"
            siteName="Test Site"
            siteTimezone="America/Los_Angeles"
            batterySoC={50}
            batteryPower={0}
            solarPower={0}
            gridPower={0}
            loadPower={0}
            today={[]}
            todayTotals={{ homeUsage: 0, gridImport: 0, gridExport: 0, solarProduction: 0, batteryCharge: 0, batteryDischarge: 0 }}
            todayChartRows={[]}
            todayStart={new Date('2026-08-24T07:00:00Z')}
            now={new Date('2026-08-24T19:00:00Z')}
            hasTariff={false}
            loadTiming={null}
            batteryHold={null}
            batteryNotice={null}
            sankeySnapshotSvg={null}
            sankeyCumulativeSvg={null}
        />
    );
}

describe('LiveDetailView', () => {
    it('renders Load timing above the Today chart', () => {
        const html = renderView();
        const loadTimingAt = html.indexOf('Load timing this cycle');
        const chartAt = html.indexOf('Test Site');

        expect(loadTimingAt).toBeGreaterThanOrEqual(0);
        expect(chartAt).toBeGreaterThanOrEqual(0);
        expect(loadTimingAt).toBeLessThan(chartAt);
    });

    it('still renders the Today so far section', () => {
        expect(renderView()).toContain('Today so far');
    });
});
```

If `todayTotals` fails to typecheck, run `grep -n "export interface TodayTotals" -A 12 src/lib/energy-repo.ts` and match the real field names exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/site/live/LiveDetailView.test.tsx`
Expected: FAIL — `loadTimingAt` is greater than `chartAt`, because Load timing currently renders fourth.

- [ ] **Step 3: Reorder the sections**

In `src/components/site/live/LiveDetailView.tsx`, move the entire `<SectionCard title="Load timing this cycle" …>` block so it is the first child of the wrapping `<div className="space-y-6">`, immediately before the `<SectionCard title={`${siteName} — Today`} …>` block. Move the block verbatim; do not change its props or children.

Resulting order: Load timing → Today chart → Today so far → Sankey → Battery hold.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/site/live/LiveDetailView.test.tsx`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/site/live/LiveDetailView.tsx src/components/site/live/LiveDetailView.test.tsx
git commit -m "feat(live): move Load timing to the top of the Live view"
```

---

### Task 5: "Can I run this now?" widget

**Files:**
- Create: `src/lib/run-load-view.ts`
- Create: `src/lib/run-load-view.test.ts`
- Create: `src/components/site/live/RunLoadNowWidget.tsx`
- Create: `src/components/site/live/RunLoadNowWidget.test.tsx`
- Modify: `src/lib/format-utils.ts` (append `formatDollars`)
- Modify: `src/lib/format-utils.test.ts` (add a case; create the file if absent)
- Modify: `src/components/site/live/PeriodCardRow.tsx` (mount the widget)

**Interfaces:**
- Consumes: `costToRun`, `LoadVerdict` (Task 2); `LOAD_PROFILES`, `MAX_PROFILE_KWH`, `LoadProfile` (Task 1); `LoadTimingPeriod` with `buyRate` / `sellRate` (Task 3).
- Produces: `function formatDollars(amount: number): string`; `interface RunLoadTile { name: string; costLabel: string; verdict: LoadVerdict; coveredKwh: number; boughtKwh: number; whenLabel: string; toneClass: string; barCoveredPct: number }`; `function buildRunLoadTiles(periods: LoadTimingPeriod[], loadKwh: number, headroomKwh?: number): RunLoadTile[]`; `function RunLoadNowWidget(props: { periods: LoadTimingPeriod[] }): JSX.Element`.

The pure view-model lives in `run-load-view.ts` so it is testable in the node environment; the component is a thin renderer over it.

- [ ] **Step 1: Write the failing test for the currency formatter**

Add to `src/lib/format-utils.test.ts` (create the file with `import { describe, expect, it } from 'vitest';` and the relevant import if it does not exist):

```ts
import { formatDollars } from './format-utils';

describe('formatDollars', () => {
    it('renders whole and fractional dollars to two places', () => {
        expect(formatDollars(25.2)).toBe('$25.20');
        expect(formatDollars(1.8)).toBe('$1.80');
        expect(formatDollars(0)).toBe('$0.00');
    });

    it('rounds rather than truncating', () => {
        expect(formatDollars(0.005)).toBe('$0.01');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/format-utils.test.ts`
Expected: FAIL — `formatDollars` is not exported.

- [ ] **Step 3: Implement the formatter**

Append to `src/lib/format-utils.ts`:

```ts
export function formatDollars(amount: number): string {
    return `$${amount.toFixed(2)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/format-utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the view-model**

Create `src/lib/run-load-view.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildRunLoadTiles } from './run-load-view';
import type { LoadTimingPeriod } from './load-timing';

const periods: LoadTimingPeriod[] = [
    {
        name: 'ON_PEAK', marginalCost: 0.12, basis: 'sell', cycleNetExportKwh: 10,
        isActive: true, nextStartPhrase: null, buyRate: 0.48, sellRate: 0.12,
    },
    {
        name: 'OFF_PEAK', marginalCost: 0.03, basis: 'sell', cycleNetExportKwh: 120,
        isActive: false, nextStartPhrase: 'in 2h 10m', buyRate: 0.15, sellRate: 0.03,
    },
];

describe('buildRunLoadTiles', () => {
    it('puts the active period first', () => {
        expect(buildRunLoadTiles(periods, 60)[0].name).toBe('On-Peak');
    });

    it('prices each period for the selected load', () => {
        const tiles = buildRunLoadTiles(periods, 60);
        expect(tiles[0].costLabel).toBe('$25.20');
        expect(tiles[1].costLabel).toBe('$1.80');
    });

    it('labels the active period as now and others by their start phrase', () => {
        const tiles = buildRunLoadTiles(periods, 60);
        expect(tiles[0].whenLabel).toBe('now');
        expect(tiles[1].whenLabel).toBe('in 2h 10m');
    });

    it('carries the verdict through to a tone class', () => {
        const tiles = buildRunLoadTiles(periods, 60);
        expect(tiles[0].verdict).toBe('partial');
        expect(tiles[0].toneClass).toContain('amber');
        expect(tiles[1].verdict).toBe('covered');
        expect(tiles[1].toneClass).toContain('green');
    });

    it('applies headroom so an affordable load can still read as tight', () => {
        const tiles = buildRunLoadTiles(periods, 60, 100);
        expect(tiles[1].verdict).toBe('covered'); // 120 >= 100
        const tighter = buildRunLoadTiles(periods, 60, 200);
        expect(tighter[1].verdict).toBe('tight'); // 120 < 200, still all sell-rate
        expect(tighter[1].costLabel).toBe('$1.80');
    });

    it('reports the covered share of the load as a bar percentage', () => {
        const tiles = buildRunLoadTiles(periods, 60);
        expect(tiles[0].barCoveredPct).toBeCloseTo(16.67, 1);
        expect(tiles[1].barCoveredPct).toBe(100);
    });

    it('falls back to an empty when-label if a period has no start phrase', () => {
        const orphan: LoadTimingPeriod[] = [{ ...periods[1], nextStartPhrase: null }];
        expect(buildRunLoadTiles(orphan, 5)[0].whenLabel).toBe('');
    });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- src/lib/run-load-view.test.ts`
Expected: FAIL — cannot resolve `./run-load-view`.

- [ ] **Step 7: Implement the view-model**

Create `src/lib/run-load-view.ts`:

```ts
import { costToRun, type LoadVerdict } from './load-affordance';
import { formatDollars, formatTouName } from './format-utils';
import type { LoadTimingPeriod } from './load-timing';

export interface RunLoadTile {
    name: string;
    costLabel: string;
    verdict: LoadVerdict;
    coveredKwh: number;
    boughtKwh: number;
    whenLabel: string;
    toneClass: string;
    barCoveredPct: number;
}

const TONE: Record<LoadVerdict, string> = {
    covered: 'text-green-700 dark:text-green-400',
    tight: 'text-amber-700 dark:text-amber-400',
    partial: 'text-amber-700 dark:text-amber-400',
    bought: 'text-red-700 dark:text-red-400',
};

/**
 * One tile per TOU period for the currently selected load size, active period
 * first so "what happens if I do it now" is the first thing read.
 *
 * `headroomKwh` is passed only when the user picked a preset; a custom slider
 * amount has no profile and therefore no margin to judge against.
 */
export function buildRunLoadTiles(
    periods: LoadTimingPeriod[],
    loadKwh: number,
    headroomKwh?: number
): RunLoadTile[] {
    const ordered = [...periods].sort((a, b) => Number(b.isActive) - Number(a.isActive));

    return ordered.map((p) => {
        const cost = costToRun(loadKwh, {
            surplusKwh: p.cycleNetExportKwh,
            buyRate: p.buyRate,
            sellRate: p.sellRate,
        }, headroomKwh);

        return {
            name: formatTouName(p.name),
            costLabel: formatDollars(cost.total),
            verdict: cost.verdict,
            coveredKwh: cost.coveredKwh,
            boughtKwh: cost.boughtKwh,
            whenLabel: p.isActive ? 'now' : (p.nextStartPhrase ?? ''),
            toneClass: TONE[cost.verdict],
            barCoveredPct: loadKwh > 0 ? (cost.coveredKwh / loadKwh) * 100 : 0,
        };
    });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- src/lib/run-load-view.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 9: Write the failing test for the component**

Create `src/components/site/live/RunLoadNowWidget.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunLoadNowWidget } from './RunLoadNowWidget';
import type { LoadTimingPeriod } from '@/lib/load-timing';

const periods: LoadTimingPeriod[] = [
    {
        name: 'ON_PEAK', marginalCost: 0.12, basis: 'sell', cycleNetExportKwh: 10,
        isActive: true, nextStartPhrase: null, buyRate: 0.48, sellRate: 0.12,
    },
    {
        name: 'OFF_PEAK', marginalCost: 0.03, basis: 'sell', cycleNetExportKwh: 120,
        isActive: false, nextStartPhrase: 'in 2h 10m', buyRate: 0.15, sellRate: 0.03,
    },
];

describe('RunLoadNowWidget', () => {
    it('renders a preset button for every configured profile', () => {
        const html = renderToStaticMarkup(<RunLoadNowWidget periods={periods} />);
        expect(html).toContain('Big car');
        expect(html).toContain('Little car');
        expect(html).toContain('Laundry');
        expect(html).toContain('Dishwasher');
    });

    it('prices every period for the initially selected load', () => {
        const html = renderToStaticMarkup(<RunLoadNowWidget periods={periods} />);
        expect(html).toContain('On-Peak');
        expect(html).toContain('Off-Peak');
        expect(html).toContain('in 2h 10m');
    });

    it('renders nothing when there are no periods', () => {
        expect(renderToStaticMarkup(<RunLoadNowWidget periods={[]} />)).toBe('');
    });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npm test -- src/components/site/live/RunLoadNowWidget.test.tsx`
Expected: FAIL — cannot resolve `./RunLoadNowWidget`.

- [ ] **Step 11: Implement the component**

Create `src/components/site/live/RunLoadNowWidget.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { LOAD_PROFILES, MAX_PROFILE_KWH, type LoadProfile } from '@/lib/load-profiles';
import { buildRunLoadTiles } from '@/lib/run-load-view';
import type { LoadTimingPeriod } from '@/lib/load-timing';

export interface RunLoadNowWidgetProps {
    periods: LoadTimingPeriod[];
}

export function RunLoadNowWidget({ periods }: RunLoadNowWidgetProps) {
    const initial = LOAD_PROFILES[LOAD_PROFILES.length - 1] ?? null;
    const [selected, setSelected] = useState<LoadProfile | null>(initial);
    const [loadKwh, setLoadKwh] = useState<number>(initial?.kwh ?? 5);

    if (periods.length === 0) return null;

    const tiles = buildRunLoadTiles(periods, loadKwh, selected?.headroomKwh);

    return (
        <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <p className="text-sm font-medium text-foreground">Can I run this now?</p>

            {/* Presets wrap: the profile list is expected to grow. */}
            <div className="mt-3 flex flex-wrap gap-2">
                {LOAD_PROFILES.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        onClick={() => { setSelected(p); setLoadKwh(p.kwh); }}
                        className={`rounded-full border px-3 py-1 text-xs ${
                            selected?.id === p.id
                                ? 'border-blue-500 text-blue-700 dark:text-blue-400'
                                : 'border-slate-200 text-gray-600 dark:border-slate-700 dark:text-gray-300'
                        }`}
                    >
                        {p.label} <span className="text-gray-400">{p.kwh} kWh</span>
                    </button>
                ))}
            </div>

            <label className="mt-3 block">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                    Load size: {loadKwh} kWh
                </span>
                <input
                    type="range"
                    min={1}
                    max={MAX_PROFILE_KWH}
                    step={1}
                    value={loadKwh}
                    onChange={(e) => { setSelected(null); setLoadKwh(Number(e.target.value)); }}
                    className="mt-1 w-full"
                />
            </label>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {tiles.map((t) => (
                    <div key={t.name} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            {t.name} · {t.whenLabel}
                        </p>
                        <p className={`text-xl font-semibold ${t.toneClass}`}>{t.costLabel}</p>
                        {/* The bar always reports the exact sell/buy split, even
                            when the verdict is softened to "tight". */}
                        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-red-500">
                            <div className="bg-green-500" style={{ width: `${t.barCoveredPct}%` }} />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npm test -- src/components/site/live/RunLoadNowWidget.test.tsx`
Expected: PASS, all 3 tests.

- [ ] **Step 13: Mount the widget in the Load timing card**

In `src/components/site/live/PeriodCardRow.tsx`, add the import:

```tsx
import { RunLoadNowWidget } from './RunLoadNowWidget';
```

and render it immediately after the closing `</div>` of the period-card grid, still inside the returned fragment:

```tsx
            <RunLoadNowWidget periods={loadTiming.periods} />
```

Leave both early-return branches (no tariff, no cycle data) untouched — the widget has nothing to price in either case.

- [ ] **Step 14: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add src/lib/run-load-view.ts src/lib/run-load-view.test.ts src/lib/format-utils.ts src/lib/format-utils.test.ts src/components/site/live/RunLoadNowWidget.tsx src/components/site/live/RunLoadNowWidget.test.tsx src/components/site/live/PeriodCardRow.tsx
git commit -m "feat(live): add Can I run this now widget to the Load timing card"
```

---

### Task 6: Derive today's headroom contribution from bucketed rows

**Files:**
- Create: `src/lib/headroom-from-bins.ts`
- Test: `src/lib/headroom-from-bins.test.ts`

**Interfaces:**
- Consumes: `Schedule` from `src/lib/schedule.ts`; `EnergyData` from `src/lib/db-types.ts`; `UsageData` from `src/lib/energy-repo.ts`.
- Produces: `function todayNetExportByPeriod(bins: EnergyData[], siteMidnight: Date, schedule: Schedule): Map<string, number>`; `function activePeriodSurplusKwh(priorCycle: UsageData[], todayByPeriod: Map<string, number>, activePeriodName: string): number`.

This is the piece that keeps the header free. The sparkline query already spans a rolling 24 hours and site-local midnight is never more than 24 hours ago, so today's bins are already in memory — no query changes anywhere.

Each 15-minute bin holds `AVG(grid_power)` where each underlying sample is Wh per 5 minutes, so a full bin's energy is `avg * 3` Wh. Positive means importing, so net export is negated. This over-counts a partial bin (the in-progress one, or one with missing samples); that is the documented, accepted approximation, because the value only ever selects a glyph.

- [ ] **Step 1: Write the failing test**

Create `src/lib/headroom-from-bins.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { activePeriodSurplusKwh, todayNetExportByPeriod } from './headroom-from-bins';
import type { EnergyData } from './db-types';
import type { UsageData } from './energy-repo';

const MIDNIGHT = new Date('2026-08-24T07:00:00Z');

function bin(minutesAfterMidnight: number, gridAvgWh: number): EnergyData {
    return {
        timestamp: new Date(MIDNIGHT.getTime() + minutesAfterMidnight * 60_000),
        site_id: 'site-1',
        tariff_id: 1,
        tariff_schedule_id: 1,
        load_power: 0,
        solar_power: 0,
        grid_power: gridAvgWh,
        battery_power: 0,
        battery_soc: null,
    };
}

// Minimal stand-in for Schedule: every timestamp maps to one TOU name.
function fakeSchedule(name: string) {
    return { getTariffPeriod: () => ({ schedule: { name } }) } as never;
}

describe('todayNetExportByPeriod', () => {
    it('converts bin averages to kWh, negating import into net export', () => {
        // Two bins exporting 1000 Wh each per 5-min sample => avg 1000, x3 per bin.
        const map = todayNetExportByPeriod(
            [bin(0, -1000), bin(15, -1000)],
            MIDNIGHT,
            fakeSchedule('OFF_PEAK')
        );
        // (1000 * 3 + 1000 * 3) / 1000 = 6 kWh exported
        expect(map.get('OFF_PEAK')).toBeCloseTo(6, 6);
    });

    it('treats import as negative net export', () => {
        const map = todayNetExportByPeriod([bin(0, 500)], MIDNIGHT, fakeSchedule('ON_PEAK'));
        expect(map.get('ON_PEAK')).toBeCloseTo(-1.5, 6);
    });

    it('ignores bins before site midnight', () => {
        const stale = bin(-60, -1000);
        const map = todayNetExportByPeriod([stale, bin(0, -1000)], MIDNIGHT, fakeSchedule('OFF_PEAK'));
        expect(map.get('OFF_PEAK')).toBeCloseTo(3, 6);
    });

    it('survives a gap in the data without inventing energy', () => {
        const map = todayNetExportByPeriod(
            [bin(0, -1000), bin(180, -1000)],
            MIDNIGHT,
            fakeSchedule('OFF_PEAK')
        );
        expect(map.get('OFF_PEAK')).toBeCloseTo(6, 6);
    });

    it('skips bins with no resolvable TOU period', () => {
        const noPeriod = { getTariffPeriod: () => null } as never;
        expect(todayNetExportByPeriod([bin(0, -1000)], MIDNIGHT, noPeriod).size).toBe(0);
    });

    it('returns an empty map for no bins', () => {
        expect(todayNetExportByPeriod([], MIDNIGHT, fakeSchedule('OFF_PEAK')).size).toBe(0);
    });
});

describe('activePeriodSurplusKwh', () => {
    const prior: UsageData[] = [
        {
            start: MIDNIGHT, homeUsage: 0, gridUsage: -40_000, solarProduction: 0,
            batteryChange: 0, tariff: { id: 1 } as never, touName: 'OFF_PEAK',
        },
        {
            start: MIDNIGHT, homeUsage: 0, gridUsage: 5_000, solarProduction: 0,
            batteryChange: 0, tariff: { id: 1 } as never, touName: 'ON_PEAK',
        },
    ];

    it('adds today onto the prior-day rollup for the active period', () => {
        const today = new Map([['OFF_PEAK', 6]]);
        // prior: -(-40000)/1000 = 40 kWh exported, plus 6 today
        expect(activePeriodSurplusKwh(prior, today, 'OFF_PEAK')).toBeCloseTo(46, 6);
    });

    it('returns a negative surplus when the period is in deficit', () => {
        expect(activePeriodSurplusKwh(prior, new Map(), 'ON_PEAK')).toBeCloseTo(-5, 6);
    });

    it('handles a period present only in today', () => {
        expect(activePeriodSurplusKwh(prior, new Map([['SHOULDER', 2]]), 'SHOULDER')).toBeCloseTo(2, 6);
    });

    it('returns zero for a period in neither source', () => {
        expect(activePeriodSurplusKwh(prior, new Map(), 'MYSTERY')).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/headroom-from-bins.test.ts`
Expected: FAIL — cannot resolve `./headroom-from-bins`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/headroom-from-bins.ts`:

```ts
import type { EnergyData } from './db-types';
import type { UsageData } from './energy-repo';
import type { Schedule } from './schedule';

/** Each 15-minute bin holds the average of three 5-minute Wh samples. */
const SAMPLES_PER_BIN = 3;

/**
 * Today's net export per TOU period, in kWh, derived from the 15-minute bins
 * the live-data route already fetches for the sparklines.
 *
 * Deliberately approximate: a partial bin (the in-progress one, or one missing
 * samples) is scaled as if it were full, so the result can run slightly high.
 * This value only ever selects a header glyph — the Live page runs the exact
 * computation. See the design doc's "Egress and precision".
 */
export function todayNetExportByPeriod(
    bins: EnergyData[],
    siteMidnight: Date,
    schedule: Schedule
): Map<string, number> {
    const byPeriod = new Map<string, number>();

    for (const b of bins) {
        if (b.timestamp < siteMidnight) continue;

        const tp = schedule.getTariffPeriod(b.timestamp);
        if (!tp) continue;

        const name = tp.schedule.name ?? 'Unknown';
        // grid_power is positive on import; negate for export-positive kWh.
        const kwh = -(b.grid_power * SAMPLES_PER_BIN) / 1000;
        byPeriod.set(name, (byPeriod.get(name) ?? 0) + kwh);
    }

    return byPeriod;
}

/**
 * Cycle-to-date surplus for one TOU period: the cached rollup of completed
 * days plus today's contribution. Negative means the period is in deficit.
 */
export function activePeriodSurplusKwh(
    priorCycle: UsageData[],
    todayByPeriod: Map<string, number>,
    activePeriodName: string
): number {
    const prior = priorCycle
        .filter(u => (u.touName ?? 'Unknown') === activePeriodName)
        .reduce((sum, u) => sum + -(u.gridUsage) / 1000, 0);

    return prior + (todayByPeriod.get(activePeriodName) ?? 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/headroom-from-bins.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/headroom-from-bins.ts src/lib/headroom-from-bins.test.ts
git commit -m "feat(loads): derive today's period headroom from bucketed rows"
```

---

### Task 7: Serve loadHeadroom from the live-data API

**Files:**
- Create: `src/lib/cycle-rollup-cache.ts`
- Test: `src/lib/cycle-rollup-cache.test.ts`
- Modify: `src/app/api/site-live-data/route.ts`
- Modify: `src/lib/site-live-data-client.ts:23-31`

**Interfaces:**
- Consumes: `todayNetExportByPeriod`, `activePeriodSurplusKwh` (Task 6); `glyphForHeadroom`, `profileForHeadroom` (Task 2); `LoadGlyph` (Task 1).
- Produces: `function getCachedCycleRollup(siteId: string, cycleStart: Date, siteMidnight: Date, load: () => Promise<UsageData[]>): Promise<UsageData[]>`; `clearCycleRollupCache()` for tests. `SiteLiveData` gains `loadHeadroom?: { surplusKwh: number; periodName: string; glyph: LoadGlyph | null; profileLabel: string | null } | null`.

The rollup of completed days changes only at site-local midnight, so it is memoised per `(siteId, siteMidnight)`. This is the same per-instance caching pattern as the pooled `pg` client — a cold instance pays it once, a warm one once per site per day.

- [ ] **Step 1: Write the failing test for the cache**

Create `src/lib/cycle-rollup-cache.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCycleRollupCache, getCachedCycleRollup } from './cycle-rollup-cache';
import type { UsageData } from './energy-repo';

const CYCLE_START = new Date('2026-08-16T07:00:00Z');
const MIDNIGHT = new Date('2026-08-24T07:00:00Z');
const NEXT_MIDNIGHT = new Date('2026-08-25T07:00:00Z');

const rows: UsageData[] = [];

beforeEach(() => clearCycleRollupCache());

describe('getCachedCycleRollup', () => {
    it('loads once and reuses the result for the same day', async () => {
        const load = vi.fn().mockResolvedValue(rows);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('reloads when the day boundary moves', async () => {
        const load = vi.fn().mockResolvedValue(rows);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load);
        await getCachedCycleRollup('s1', CYCLE_START, NEXT_MIDNIGHT, load);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('caches per site', async () => {
        const load = vi.fn().mockResolvedValue(rows);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load);
        await getCachedCycleRollup('s2', CYCLE_START, MIDNIGHT, load);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not cache a rejected load', async () => {
        const failing = vi.fn().mockRejectedValue(new Error('db down'));
        await expect(getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, failing)).rejects.toThrow('db down');
        const ok = vi.fn().mockResolvedValue(rows);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, ok);
        expect(ok).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/cycle-rollup-cache.test.ts`
Expected: FAIL — cannot resolve `./cycle-rollup-cache`.

- [ ] **Step 3: Implement the cache**

Create `src/lib/cycle-rollup-cache.ts`:

```ts
import type { UsageData } from './energy-repo';

interface Entry {
    key: string;
    rows: UsageData[];
}

const cache = new Map<string, Entry>();

/**
 * Memoises the completed-days portion of the cycle rollup, which only changes
 * at site-local midnight. Cached per running instance, so a warm instance pays
 * the query once per site per day.
 */
export async function getCachedCycleRollup(
    siteId: string,
    cycleStart: Date,
    siteMidnight: Date,
    load: () => Promise<UsageData[]>
): Promise<UsageData[]> {
    const key = `${cycleStart.toISOString()}|${siteMidnight.toISOString()}`;
    const hit = cache.get(siteId);
    if (hit && hit.key === key) return hit.rows;

    // Awaited before caching so a failed load is never memoised.
    const rows = await load();
    cache.set(siteId, { key, rows });
    return rows;
}

export function clearCycleRollupCache(): void {
    cache.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/cycle-rollup-cache.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Extend the client type**

In `src/lib/site-live-data-client.ts`, add the import and the field:

```ts
import type { LoadGlyph } from './load-profiles';

export interface SiteLiveDataHeadroom {
    surplusKwh: number;
    periodName: string;
    glyph: LoadGlyph | null;
    profileLabel: string | null;
}
```

and inside `SiteLiveData`, after `currentTariff?: string;`:

```ts
    loadHeadroom?: SiteLiveDataHeadroom | null;
```

- [ ] **Step 6: Wire the route**

In `src/app/api/site-live-data/route.ts`, add imports:

```ts
import { Schedule } from '@/lib/schedule';
import { getCurrentCycleStart } from '@/lib/billing-cycle';
import { getCachedCycleRollup } from '@/lib/cycle-rollup-cache';
import { activePeriodSurplusKwh, todayNetExportByPeriod } from '@/lib/headroom-from-bins';
import { glyphForHeadroom, profileForHeadroom } from '@/lib/load-affordance';
import type { SiteLiveDataHeadroom } from '@/lib/site-live-data-client';
```

After `const currentTariff = getCurrentTariffLabel(site);`, insert:

```ts
            // Headroom for the active TOU period. Today's contribution comes
            // from `historyRows`, already fetched above for the sparklines —
            // the rolling 24h window always covers site-local midnight — so
            // the only added query is the completed-days rollup, cached to the
            // day boundary.
            let loadHeadroom: SiteLiveDataHeadroom | null = null;
            try {
                if ((site?.tariffs?.length ?? 0) > 0) {
                    const schedule = new Schedule(site!.tariffs, site!.timezone);
                    const activeName = schedule.getTariffPeriod(now)?.schedule.name ?? null;

                    if (activeName) {
                        const siteMidnight = EnergyRepo.getSiteMidnight(now, site!.timezone);
                        const cycleStart = getCurrentCycleStart(site!.billing_start_day, now, site!.timezone);

                        const priorCycle = await getCachedCycleRollup(
                            siteId, cycleStart, siteMidnight,
                            () => repo.getUsageByTOU(siteId, cycleStart, siteMidnight)
                        );

                        const surplusKwh = activePeriodSurplusKwh(
                            priorCycle,
                            todayNetExportByPeriod(historyRows, siteMidnight, schedule),
                            activeName
                        );

                        loadHeadroom = {
                            surplusKwh,
                            periodName: activeName,
                            glyph: glyphForHeadroom(surplusKwh),
                            profileLabel: profileForHeadroom(surplusKwh)?.label ?? null,
                        };
                    }
                }
            } catch (headroomError) {
                // Never fail the live strip over the glyph.
                console.warn('[site-live-data] headroom unavailable:', headroomError);
            }
```

Then add `loadHeadroom,` to the `NextResponse.json({ … })` object, after `currentTariff,`.

- [ ] **Step 7: Verify the whole suite and the build**

Run: `npm test`
Expected: PASS.

Run: `npm run build`
Expected: build succeeds. This is the step that catches a bad `EnergyRepo.getSiteMidnight` import or a `site` possibly-undefined type error — `site` is `SiteWithTariffs | undefined`, so guard it rather than reaching for `!` if the compiler objects.

- [ ] **Step 8: Commit**

```bash
git add src/lib/cycle-rollup-cache.ts src/lib/cycle-rollup-cache.test.ts src/lib/site-live-data-client.ts src/app/api/site-live-data/route.ts
git commit -m "feat(api): serve active-period load headroom from site-live-data"
```

---

### Task 8: Load headroom glyph in the live status header

**Files:**
- Create: `src/components/ui/LoadHeadroomGlyph.tsx`
- Test: `src/components/ui/LoadHeadroomGlyph.test.tsx`
- Modify: `src/components/HeaderLiveStats.tsx`

**Interfaces:**
- Consumes: `LoadGlyph` (Task 1); `SiteLiveDataHeadroom` (Task 7).
- Produces: `function LoadHeadroomGlyph(props: { headroom: SiteLiveDataHeadroom | null | undefined }): JSX.Element | null`.

Treatment 2 from the design: a tinted pill holding the glyph alone, no number. The `title` names the profile and surplus; the exact figures live one tap away on the Live page.

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/LoadHeadroomGlyph.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoadHeadroomGlyph } from './LoadHeadroomGlyph';

describe('LoadHeadroomGlyph', () => {
    it('renders nothing when headroom is unavailable', () => {
        expect(renderToStaticMarkup(<LoadHeadroomGlyph headroom={null} />)).toBe('');
        expect(renderToStaticMarkup(<LoadHeadroomGlyph headroom={undefined} />)).toBe('');
    });

    it('names the selected profile and surplus in the tooltip', () => {
        const html = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: 120.4, periodName: 'OFF_PEAK', glyph: 'car', profileLabel: 'Little car',
            }} />
        );
        expect(html).toContain('Off-Peak');
        expect(html).toContain('120 kWh');
        expect(html).toContain('Little car');
    });

    it('uses a danger tone when nothing clears the smallest threshold', () => {
        const html = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: -8, periodName: 'ON_PEAK', glyph: null, profileLabel: null,
            }} />
        );
        expect(html).toContain('red');
        expect(html).toContain('avoid large loads');
    });

    it('tones the small tier as a warning and larger tiers as success', () => {
        const small = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: 6, periodName: 'ON_PEAK', glyph: 'small', profileLabel: 'Dishwasher',
            }} />
        );
        const large = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: 200, periodName: 'OFF_PEAK', glyph: 'car', profileLabel: 'Big car',
            }} />
        );
        expect(small).toContain('amber');
        expect(large).toContain('green');
    });

    it('is hidden from assistive tech only via the icon, not the label', () => {
        const html = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: 30, periodName: 'OFF_PEAK', glyph: 'appliance', profileLabel: 'Laundry',
            }} />
        );
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('sr-only');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/ui/LoadHeadroomGlyph.test.tsx`
Expected: FAIL — cannot resolve `./LoadHeadroomGlyph`.

- [ ] **Step 3: Implement the glyph component**

Create `src/components/ui/LoadHeadroomGlyph.tsx`. The four icons are hand-authored 24×24 outline SVGs matching the `SolarIcon` / `GridIcon` style already in `HeaderLiveStats.tsx` — heroicons ships neither a car nor a washing machine. Adding a fifth icon later means one SVG, one `ICONS` entry, and one member on `LoadGlyph`.

```tsx
import type { ComponentType } from 'react';
import { formatTouName } from '@/lib/format-utils';
import type { LoadGlyph } from '@/lib/load-profiles';
import type { SiteLiveDataHeadroom } from '@/lib/site-live-data-client';

const ICON_PROPS = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'h-3.5 w-3.5',
    'aria-hidden': true,
};

function CarIcon() {
    return (
        <svg {...ICON_PROPS}>
            <path d="M3 13.5l1.8-5.4A2 2 0 016.7 6.75h10.6a2 2 0 011.9 1.35l1.8 5.4" />
            <path d="M3 13.5h18v4.5H3z" />
            <path d="M6.75 18v1.5M17.25 18v1.5" />
        </svg>
    );
}

function ApplianceIcon() {
    return (
        <svg {...ICON_PROPS}>
            <rect x="4.5" y="3" width="15" height="18" rx="2" />
            <circle cx="12" cy="14" r="4" />
            <path d="M8 6.5h.01M11 6.5h.01" />
        </svg>
    );
}

function SmallIcon() {
    return (
        <svg {...ICON_PROPS}>
            <path d="M9 18h6M10 21h4" />
            <path d="M12 3a6 6 0 00-3.5 10.9V15h7v-1.1A6 6 0 0012 3z" />
        </svg>
    );
}

function AvoidIcon() {
    return (
        <svg {...ICON_PROPS}>
            <path d="M12 3l9 16H3l9-16z" />
            <path d="M12 9.5v4M12 16.5h.01" />
        </svg>
    );
}

const ICONS: Record<LoadGlyph, ComponentType> = {
    car: CarIcon,
    appliance: ApplianceIcon,
    small: SmallIcon,
};

const TONES: Record<LoadGlyph | 'none', string> = {
    car: 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950/40',
    appliance: 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950/40',
    small: 'text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/40',
    none: 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950/40',
};

export interface LoadHeadroomGlyphProps {
    headroom: SiteLiveDataHeadroom | null | undefined;
}

export function LoadHeadroomGlyph({ headroom }: LoadHeadroomGlyphProps) {
    if (!headroom) return null;

    const Icon = headroom.glyph ? ICONS[headroom.glyph] : AvoidIcon;
    const tone = TONES[headroom.glyph ?? 'none'];

    const summary = headroom.profileLabel
        ? `${formatTouName(headroom.periodName)} · ${Math.round(headroom.surplusKwh)} kWh surplus — ${headroom.profileLabel}`
        : `${formatTouName(headroom.periodName)} · ${Math.round(headroom.surplusKwh)} kWh — avoid large loads`;

    return (
        <span
            title={summary}
            className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 ${tone}`}
        >
            <Icon />
            <span className="sr-only">{summary}</span>
        </span>
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/ui/LoadHeadroomGlyph.test.tsx`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Mount the glyph in the header**

In `src/components/HeaderLiveStats.tsx`:

1. Add the import: `import { LoadHeadroomGlyph } from '@/components/ui/LoadHeadroomGlyph';`
2. Add `loadHeadroom` to `HeaderMetricsStripProps` as `SiteLiveDataHeadroom | null | undefined`, and pass `loadHeadroom={stats.loadHeadroom}` where `HeaderMetricsStrip` is rendered.
3. Inside `HeaderMetricsStrip`, render `<LoadHeadroomGlyph headroom={loadHeadroom} />` immediately **before** the "View detail link affordance" `<span>`, so the glyph sits at the end of the metrics but ahead of the hover affordance.

Do not route this through `buildHeaderMetricsModel` — that function derives formatted numbers from raw live values, and the headroom arrives already shaped from the API.

- [ ] **Step 6: Run the full suite, lint, and build**

Run: `npm test`
Expected: PASS.

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/LoadHeadroomGlyph.tsx src/components/ui/LoadHeadroomGlyph.test.tsx src/components/HeaderLiveStats.tsx
git commit -m "feat(header): add load headroom glyph to the live status strip"
```

---

### Task 9: Verify end to end against a real site

**Files:**
- Modify: none expected. Fix whatever this surfaces.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Confirm the whole suite, lint, and build are green**

```bash
npm test && npm run lint && npm run build
```

Expected: all three pass. Do not proceed past a failure — fix it.

- [ ] **Step 2: Start the agent dev server**

Run: `npm run dev:agent`

Uses port 5174; the user's own server occupies 5173. If the port is busy, `npm run build && npx next start -p 5174`.

- [ ] **Step 3: Check the Live view**

Open `http://localhost:5174/site/<id>/live` for a site with a configured tariff. Confirm:
- "Load timing this cycle" is the first card on the page.
- The "Can I run this now?" widget renders preset chips for all four profiles.
- Clicking a preset changes every period tile's dollar figure.
- Dragging the slider updates the figures without a page reload or network request.

- [ ] **Step 4: Check the header glyph**

On any site page, confirm the glyph pill renders at the end of the live strip, and that hovering shows the period, surplus, and profile name. A site with no tariff must render no pill and no layout gap.

- [ ] **Step 5: Confirm no added per-poll egress**

Watch the dev server console across at least two `/api/site-live-data` polls (five minutes apart, or force a refresh). The `[EnergyRepo]` log lines for the second poll must show **no** `getCycleAggregates` or `getRawEnergyData` call attributable to headroom — only the `getBucketedEnergyData` call that was already there. Seeing the rollup query on every poll means the cache key is wrong; fix it before finishing.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in end-to-end verification"
```

---

## Self-Review

**Spec coverage:** Load profile JSON + loader (Task 1), affordance core with `tight` verdict and `profileForHeadroom` (Task 2), `buyRate`/`sellRate` on `LoadTimingPeriod` (Task 3), Live view reorder (Task 4), widget with wrapping presets and slider (Task 5), zero-egress headroom derivation (Task 6), API field plus day-boundary cache (Task 7), treatment-2 glyph with profile-naming tooltip and icon registry (Task 8), verification including the egress check (Task 9). Every spec section maps to a task.

**Known gap accepted from the spec:** the header glyph's approximation can disagree with the Live page by one bin near a threshold. Documented in the spec, asserted nowhere — there is no test for it because it is a tolerated behaviour, not a contract.
