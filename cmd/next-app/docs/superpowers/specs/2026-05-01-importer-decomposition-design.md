# Importer Decomposition Design

**Date:** 2026-05-01  
**Status:** Approved

## Problem

`src/lib/importer.ts` is ~1000 lines and mixes pure business logic with I/O (Tesla API calls and DB writes) throughout. This makes it hard to test — any test touching gap detection, SoC matching, or tariff parsing must also mock the Tesla client and database. The current file was not built with TDD and it shows.

## Goal

Decompose `importer.ts` into a **functional core / imperative shell** architecture: pure modules containing all business logic (fully unit-testable with no mocks), and a thin `Importer` shell that handles I/O and orchestration.

This session covers `importer.ts` only. `trmnl-renderer.ts` follows in a separate session.

## Module Structure

```
src/lib/
  importer/
    soc-interpolation.ts      # pure: nearest-neighbor SoC matching
    energy-transformer.ts     # pure: Tesla API response → EnergyDataRow[]
    import-planner.ts         # pure: coverage → fetch plan (gap detection, chunking, UTC splitting)
    tariff-parser.ts          # pure: Tesla tariff_content_v2 → TariffSeason[]/TariffSchedule[]
    index.ts                  # Importer class (imperative shell, ~300–400 lines)
  importer.ts                 # backward-compat shim: re-exports from importer/
```

Each pure module has a `.test.ts` file co-located with it. The `Importer` shell (`index.ts`) is not unit-tested — its behavior is covered by the existing integration/fleet test suite.

## Pure Core Modules

### `soc-interpolation.ts`

**Responsibility:** Given an array of SoC samples and a target timestamp, return the nearest matching SoC value (or `null` if no sample is within the configured max gap).

**Source:** Extracted from `importer.ts` lines ~737–767 (`findNearestSoeValue` + binary search logic).

**Interface:**
```typescript
interface SocSample {
  timestamp: Date;
  soc: number;
}

function findNearestSoc(
  samples: SocSample[],
  target: Date,
  maxGapMs?: number  // defaults to current threshold
): number | null
```

**Tests:** Exact match, nearest before/after, gap beyond threshold returns null, empty samples returns null.

`SocSample` is exported from this module and imported by `energy-transformer.ts`.

---

### `energy-transformer.ts`

**Responsibility:** Given raw Tesla API energy points, SoC samples, a site/tariff ID, and a tariff period lookup function, return normalized `EnergyDataRow[]` ready to write to the DB.

**Source:** Extracted from `importer.ts` lines ~663–735 (scaling, energy→power conversion, tariff period lookup, SoC matching).

**Interface:**
```typescript
interface TeslaEnergyPoint {
  timestamp: string;
  energy_imported: number;
  energy_exported: number;
  solar_energy_exported: number;
  battery_energy_imported: number;
  battery_energy_exported: number;
  // ... other Tesla fields
}

interface TransformOptions {
  siteId: number;
  tariffId: number;
  socSamples: SocSample[];
  getTariffPeriod: (ts: Date) => string | null;
}

function transformEnergyPoints(
  points: TeslaEnergyPoint[],
  options: TransformOptions
): EnergyDataRow[]
```

**Tests:** Correct energy→power scaling, SoC matched to nearest sample, tariff period assigned, missing SoC handled gracefully.

---

### `import-planner.ts`

**Responsibility:** Given the existing DB coverage (array of known timestamps) and a requested date range, return the list of date windows that need to be fetched from Tesla. Encapsulates gap detection (>30 min gap → full-day refetch), 24h chunking, and UTC midnight splitting.

**Source:** Extracted from `importer.ts` lines ~162–283 (gap detection, range auditing) and lines ~294–328 (chunking/midnight splitting).

**Interface:**
```typescript
interface DateWindow {
  start: Date;
  end: Date;
}

interface PlanOptions {
  requestedRange: DateWindow;
  existingTimestamps: Date[];
  installationDate?: Date;
  forceRefetch?: boolean;
  gapThresholdMs?: number;  // defaults to 30 min
}

function planImport(options: PlanOptions): DateWindow[]

// Also exported for independent use:
function splitAtUtcMidnight(window: DateWindow): DateWindow[]
function chunkInto24h(window: DateWindow): DateWindow[]
```

**Tests:** No gaps → no windows returned, single gap triggers full-day window, force refetch overrides coverage, UTC midnight split produces correct boundaries, installation date clamps range, overlapping coverage handled correctly.

---

### `tariff-parser.ts`

**Responsibility:** Parse Tesla's `tariff_content_v2` JSON into the app's `TariffSeason` / `TariffSchedule` schema. Build fallback defaults when Tesla data is absent or malformed.

**Source:** Extracted from `importer.ts` lines ~464–574 (`ensureSite` tariff parsing block).

**Interface:**
```typescript
interface ParsedTariff {
  seasons: Omit<TariffSeason, 'id' | 'tariff_id'>[];
  schedules: Omit<TariffSchedule, 'id' | 'season_id'>[];
}

function parseTeslaRateContent(content: unknown): ParsedTariff
function buildFallbackTariff(): ParsedTariff
```

**Tests:** Well-formed Tesla content parses correctly, missing seasons falls back to default, malformed input returns fallback, TOU periods mapped to correct day-of-week + hour ranges.

---

## Imperative Shell (`importer/index.ts`)

The `Importer` class retains only I/O responsibilities:

- Reads existing coverage from DB (via `EnergyRepo`)
- Delegates to `planImport()` for what to fetch
- Calls Tesla Fleet API (`TeslaClient`) for each window
- Delegates to `transformEnergyPoints()` for normalization
- Writes `EnergyDataRow[]` to DB in batched transactions
- Manages `pendingSyncs` concurrency state
- Calls `tariff-parser` to build schema objects, then writes to DB
- Handles tariff ID remapping after tariff rotation

The shell is ~300–400 lines (down from ~1000). It is not unit-tested directly; its behavior is validated by the existing `test:fleet` integration suite.

## Backward Compatibility

`src/lib/importer.ts` becomes a one-line shim:

```typescript
export * from './importer/index';
```

All existing call sites (`api/cron/*`, `api/trmnl/*`, etc.) continue to import from `'../lib/importer'` unchanged.

## Migration Strategy

Extract one module at a time, in this order (pure-est first):

1. `soc-interpolation.ts` — smallest, most self-contained, zero external dependencies
2. `tariff-parser.ts` — pure parsing, no runtime state
3. `energy-transformer.ts` — depends on `soc-interpolation`
4. `import-planner.ts` — most complex pure logic; extract last to avoid disrupting the shell mid-refactor
5. Update `Importer` class to delegate to all four modules, reduce to shell
6. Replace `src/lib/importer.ts` with shim

Each step: extract → write tests → update `Importer` to call extracted module → verify `npm run build` and `npm test` pass before moving to the next.

## Success Criteria

- Each pure module has ≥5 passing unit tests covering its core logic paths
- `npm test` and `npm run build` pass throughout
- `src/lib/importer/index.ts` is ≤400 lines
- No call sites outside `src/lib/importer/` import directly from the sub-modules (all access goes through `src/lib/importer.ts`)
