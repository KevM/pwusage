# Importer Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `src/lib/importer.ts` into a functional core / imperative shell — four pure, unit-tested modules plus a thin `Importer` class that handles only I/O.

**Architecture:** Pure modules (`soc-interpolation`, `tariff-parser`, `energy-transformer`, `import-planner`) live under `src/lib/importer/` and contain all business logic with no DB or Tesla API dependencies. The `Importer` class moves to `src/lib/importer/index.ts` as a thin orchestration shell. `src/lib/importer.ts` becomes a one-line re-export shim so all call sites remain unchanged.

**Tech Stack:** TypeScript, Vitest, Next.js 15 App Router, `pg` (PostgreSQL)

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `src/lib/importer/soc-interpolation.ts` | Pure: nearest-neighbor SoC matching |
| Create | `src/lib/importer/soc-interpolation.test.ts` | Unit tests |
| Create | `src/lib/importer/tariff-parser.ts` | Pure: Tesla TariffV2 → parsed schema |
| Create | `src/lib/importer/tariff-parser.test.ts` | Unit tests |
| Create | `src/lib/importer/energy-transformer.ts` | Pure: Tesla history → EnergyDataRow[] |
| Create | `src/lib/importer/energy-transformer.test.ts` | Unit tests |
| Create | `src/lib/importer/import-planner.ts` | Pure: gap detection + UTC chunking |
| Create | `src/lib/importer/import-planner.test.ts` | Unit tests |
| Create | `src/lib/importer/index.ts` | Importer shell (moved from importer.ts) |
| Modify | `src/lib/importer.ts` | Replace with one-line re-export shim |

---

## Task 1: Extract `soc-interpolation.ts`

Extracts `findNearestSoeValue` from `importer.ts:737–767`. The new module takes `SocSample[]` (a flat sorted array of objects) instead of parallel arrays and a Map, which is a cleaner interface.

**Files:**
- Create: `src/lib/importer/soc-interpolation.ts`
- Create: `src/lib/importer/soc-interpolation.test.ts`
- Modify: `src/lib/importer.ts:663–735` (update `processHistory` to import and call `findNearestSoc`)

- [ ] **Step 1.1: Create the stub**

```typescript
// src/lib/importer/soc-interpolation.ts

export interface SocSample {
    timestampMs: number;
    soc: number;
}

export function buildSocSamples(
    entries: { timestamp: string; percentage_charged: number }[]
): SocSample[] {
    throw new Error('not implemented');
}

export function findNearestSoc(
    sortedSamples: SocSample[],
    targetMs: number,
    maxGapMs: number = 5 * 60 * 1000
): number | null {
    throw new Error('not implemented');
}
```

- [ ] **Step 1.2: Write failing tests**

```typescript
// src/lib/importer/soc-interpolation.test.ts
import { describe, it, expect } from 'vitest';
import { buildSocSamples, findNearestSoc, SocSample } from './soc-interpolation';

describe('findNearestSoc', () => {
    it('returns null for empty samples', () => {
        expect(findNearestSoc([], 1000)).toBeNull();
    });

    it('returns exact match', () => {
        const samples: SocSample[] = [{ timestampMs: 1000, soc: 80 }];
        expect(findNearestSoc(samples, 1000)).toBe(80);
    });

    it('returns nearest sample before target', () => {
        const samples: SocSample[] = [
            { timestampMs: 1000, soc: 70 },
            { timestampMs: 3000, soc: 90 },
        ];
        expect(findNearestSoc(samples, 1500)).toBe(70);
    });

    it('returns nearest sample after target', () => {
        const samples: SocSample[] = [
            { timestampMs: 1000, soc: 70 },
            { timestampMs: 3000, soc: 90 },
        ];
        expect(findNearestSoc(samples, 2600)).toBe(90);
    });

    it('returns null when nearest is beyond default maxGapMs (5 min)', () => {
        const samples: SocSample[] = [{ timestampMs: 0, soc: 50 }];
        const sixMinutesMs = 6 * 60 * 1000;
        expect(findNearestSoc(samples, sixMinutesMs)).toBeNull();
    });

    it('returns value when nearest is within custom maxGapMs', () => {
        const samples: SocSample[] = [{ timestampMs: 0, soc: 50 }];
        const twoMinutesMs = 2 * 60 * 1000;
        expect(findNearestSoc(samples, twoMinutesMs, 3 * 60 * 1000)).toBe(50);
    });

    it('returns null when bestTimestamp is null', () => {
        const samples: SocSample[] = [{ timestampMs: 1000, soc: 50 }];
        expect(findNearestSoc(samples, 1000 + 10 * 60 * 1000)).toBeNull();
    });
});

describe('buildSocSamples', () => {
    it('maps entries to SocSample objects', () => {
        const entries = [{ timestamp: '2026-01-01T00:00:00.000Z', percentage_charged: 80 }];
        const samples = buildSocSamples(entries);
        expect(samples[0].soc).toBe(80);
        expect(samples[0].timestampMs).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
    });

    it('sorts entries by timestamp ascending', () => {
        const entries = [
            { timestamp: '2026-01-01T00:10:00.000Z', percentage_charged: 90 },
            { timestamp: '2026-01-01T00:00:00.000Z', percentage_charged: 80 },
        ];
        const samples = buildSocSamples(entries);
        expect(samples[0].soc).toBe(80);
        expect(samples[1].soc).toBe(90);
    });

    it('filters out entries with invalid timestamps', () => {
        const entries = [
            { timestamp: 'not-a-date', percentage_charged: 50 },
            { timestamp: '2026-01-01T00:00:00.000Z', percentage_charged: 80 },
        ];
        expect(buildSocSamples(entries)).toHaveLength(1);
    });
});
```

- [ ] **Step 1.3: Run tests — verify they fail**

```bash
cd cmd/next-app && npm test -- src/lib/importer/soc-interpolation.test.ts
```

Expected: `Error: not implemented`

- [ ] **Step 1.4: Implement**

Replace the stub in `src/lib/importer/soc-interpolation.ts` with:

```typescript
// src/lib/importer/soc-interpolation.ts

export interface SocSample {
    timestampMs: number;
    soc: number;
}

export function buildSocSamples(
    entries: { timestamp: string; percentage_charged: number }[]
): SocSample[] {
    return entries
        .map(e => ({ timestampMs: new Date(e.timestamp).getTime(), soc: e.percentage_charged }))
        .filter(s => !Number.isNaN(s.timestampMs))
        .sort((a, b) => a.timestampMs - b.timestampMs);
}

export function findNearestSoc(
    sortedSamples: SocSample[],
    targetMs: number,
    maxGapMs: number = 5 * 60 * 1000
): number | null {
    if (sortedSamples.length === 0) return null;

    let lo = 0;
    let hi = sortedSamples.length - 1;

    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (sortedSamples[mid].timestampMs < targetMs) lo = mid + 1;
        else hi = mid;
    }

    const candidates: SocSample[] = [sortedSamples[lo]];
    if (lo > 0) candidates.push(sortedSamples[lo - 1]);
    if (lo + 1 < sortedSamples.length) candidates.push(sortedSamples[lo + 1]);

    let best: SocSample | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
        const d = Math.abs(c.timestampMs - targetMs);
        if (d < bestDistance) {
            bestDistance = d;
            best = c;
        }
    }

    if (best === null || bestDistance > maxGapMs) return null;
    return best.soc;
}
```

- [ ] **Step 1.5: Run tests — verify they pass**

```bash
cd cmd/next-app && npm test -- src/lib/importer/soc-interpolation.test.ts
```

Expected: all 9 tests pass

- [ ] **Step 1.6: Update `processHistory` in `importer.ts` to use the new module**

Add this import at the top of `src/lib/importer.ts`:

```typescript
import { buildSocSamples, findNearestSoc } from './importer/soc-interpolation';
```

Replace `processHistory` lines 663–735 in `src/lib/importer.ts`. The key change is replacing the manual Map+sorted-array pattern with `buildSocSamples` and `findNearestSoc`, and removing `findNearestSoeValue`:

```typescript
private async processHistory(
    client: PoolClient,
    site: SiteWithTariffs,
    history: EnergyHistoryEntry[],
    soeHistory: SoeHistoryEntry[],
    period: string = 'day',
    requestedDurationHours: number = 24
): Promise<EnergyDataRow[]> {
    const schedule = new Schedule(site.tariffs, site.timezone);
    const results: EnergyDataRow[] = [];
    const socSamples = buildSocSamples(soeHistory);

    for (let i = 0; i < history.length; i++) {
        const h = history[i];
        const ts = new Date(h.timestamp);

        let durationHours = 24;
        if (i < history.length - 1) {
            const nextTs = new Date(history[i + 1].timestamp).getTime();
            durationHours = (nextTs - ts.getTime()) / (3600 * 1000);
        } else if (i > 0) {
            const prevTs = new Date(history[i - 1].timestamp).getTime();
            durationHours = (ts.getTime() - prevTs) / (3600 * 1000);
        }

        const shouldScaleDailyAggregate = period === 'day' && requestedDurationHours > 20 && durationHours > 20;
        const scale = shouldScaleDailyAggregate ? 1000 : 1;

        const hSolar = (h.total_solar_generation || h.solar_energy_exported) ?? 0;
        const hHome = h.total_home_usage ?? 0;

        const tp = this.getTariffPeriodOrFallback(site, schedule, ts);
        if (!tp) continue;

        const gridImported = h.grid_energy_imported ?? 0;
        const gridExported = h.total_grid_energy_exported ?? 0;
        let grid = gridImported;
        if (grid === 0) grid = -gridExported;

        const batteryCharge = h.total_battery_charge ?? 0;
        const batteryDischarge = h.total_battery_discharge ?? 0;
        let battery = batteryCharge;
        if (battery === 0) battery = -batteryDischarge;

        const nearestSoc = findNearestSoc(socSamples, ts.getTime());

        results.push({
            site_id: site.id,
            tariff_id: Number(tp.tariff.id),
            timestamp: ts,
            load_power: hHome * scale,
            solar_power: hSolar * scale,
            grid_power: grid * scale,
            battery_power: battery * scale,
            battery_soc: nearestSoc,
        });
    }
    return results;
}
```

Also delete the `findNearestSoeValue` method (lines 737–767) from `importer.ts`.

- [ ] **Step 1.7: Build and test**

```bash
cd cmd/next-app && npm run build && npm test
```

Expected: build succeeds, all tests pass (including existing `importer.test.ts`)

- [ ] **Step 1.8: Commit**

```bash
git add src/lib/importer/soc-interpolation.ts src/lib/importer/soc-interpolation.test.ts src/lib/importer.ts
git commit -m "refactor: extract soc-interpolation module with tests"
```

---

## Task 2: Extract `tariff-parser.ts`

Extracts the tariff schema parsing logic from `updateTariffs` (lines 464–574) into a pure function. The parser takes Tesla's `TariffV2` object and returns a plain description of the tariff — no DB calls needed.

**Files:**
- Create: `src/lib/importer/tariff-parser.ts`
- Create: `src/lib/importer/tariff-parser.test.ts`
- Modify: `src/lib/importer.ts:464–574` (replace `updateTariffs` and `ensureDefault*` helpers to use parsed result)

- [ ] **Step 2.1: Create the stub**

```typescript
// src/lib/importer/tariff-parser.ts
import { TariffV2 } from '../tesla-client';

export interface ParsedSchedule {
    name: string;
    buy_rate: number;
    sell_rate: number;
    from_day_of_week: number;
    to_day_of_week: number;
    from_hour: number;
    from_minute: number;
    to_hour: number;
    to_minute: number;
}

export interface ParsedSeason {
    name: string;
    from_month: number;
    from_day: number;
    to_month: number;
    to_day: number;
    buy_rate: number;
    sell_rate: number;
    schedules: ParsedSchedule[];
}

export interface ParsedTariff {
    name: string;
    seasons: ParsedSeason[];
}

export function parseTariffContent(content: TariffV2, siteName: string): ParsedTariff {
    throw new Error('not implemented');
}

export function buildDefaultTariff(name: string = 'Default Rate'): ParsedTariff {
    throw new Error('not implemented');
}
```

- [ ] **Step 2.2: Write failing tests**

```typescript
// src/lib/importer/tariff-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseTariffContent, buildDefaultTariff } from './tariff-parser';
import { TariffV2 } from '../tesla-client';

const SIMPLE_TARIFF: TariffV2 = {
    code: 'E1',
    name: 'E-1',
    utility: 'PG&E',
    energy_charges: {
        Summer: { rates: { Peak: 0.40, 'Off-Peak': 0.20 } },
    },
    seasons: {
        Summer: {
            fromMonth: 6, fromDay: 1, toMonth: 9, toDay: 30,
            tou_periods: {
                Peak: {
                    periods: [{
                        fromDayOfWeek: 0, toDayOfWeek: 4,
                        fromHour: 16, fromMinute: 0,
                        toHour: 21, toMinute: 0,
                    }],
                },
                'Off-Peak': {
                    periods: [{
                        fromDayOfWeek: 0, toDayOfWeek: 6,
                        fromHour: 0, fromMinute: 0,
                        toHour: 16, toMinute: 0,
                    }],
                },
            },
        },
    },
    sell_tariff: {
        name: 'NEM',
        utility: 'PG&E',
        energy_charges: {
            Summer: { rates: { Peak: 0.10, 'Off-Peak': 0.05 } },
        },
        seasons: {},
    },
};

describe('parseTariffContent', () => {
    it('uses utility field as tariff name', () => {
        const result = parseTariffContent(SIMPLE_TARIFF, 'My Site');
        expect(result.name).toBe('PG&E');
    });

    it('falls back to siteName when utility is missing', () => {
        const t = { ...SIMPLE_TARIFF, utility: undefined as unknown as string };
        expect(parseTariffContent(t, 'My Site').name).toBe('My Site');
    });

    it('parses season date range', () => {
        const result = parseTariffContent(SIMPLE_TARIFF, 'My Site');
        expect(result.seasons[0]).toMatchObject({
            from_month: 6, from_day: 1, to_month: 9, to_day: 30,
        });
    });

    it('assigns buy and sell rates to TOU schedules', () => {
        const result = parseTariffContent(SIMPLE_TARIFF, 'My Site');
        const peak = result.seasons[0].schedules.find(s => s.name === 'Peak');
        expect(peak?.buy_rate).toBe(0.40);
        expect(peak?.sell_rate).toBe(0.10);
    });

    it('maps TOU period time range to schedule fields', () => {
        const result = parseTariffContent(SIMPLE_TARIFF, 'My Site');
        const peak = result.seasons[0].schedules.find(s => s.name === 'Peak');
        expect(peak).toMatchObject({
            from_day_of_week: 0, to_day_of_week: 4,
            from_hour: 16, from_minute: 0,
            to_hour: 21, to_minute: 0,
        });
    });

    it('renames mislabeled Summer to Winter when fromMonth >= 10', () => {
        const t: TariffV2 = {
            ...SIMPLE_TARIFF,
            seasons: {
                Summer: { fromMonth: 10, fromDay: 1, toMonth: 3, toDay: 31, tou_periods: {} },
            },
        };
        expect(parseTariffContent(t, 'Site').seasons[0].name).toBe('Winter');
    });

    it('renames mislabeled Winter to Summer when fromMonth is May–Sep', () => {
        const t: TariffV2 = {
            ...SIMPLE_TARIFF,
            seasons: {
                Winter: { fromMonth: 6, fromDay: 1, toMonth: 9, toDay: 30, tou_periods: {} },
            },
        };
        expect(parseTariffContent(t, 'Site').seasons[0].name).toBe('Summer');
    });

    it('defaults buy/sell rates to 0 when energy_charges missing for season', () => {
        const t: TariffV2 = { ...SIMPLE_TARIFF, energy_charges: {} };
        const result = parseTariffContent(t, 'Site');
        result.seasons[0].schedules.forEach(s => {
            expect(s.buy_rate).toBe(0);
        });
    });

    it('skips tou_periods entries with no periods array', () => {
        const t: TariffV2 = {
            ...SIMPLE_TARIFF,
            seasons: {
                Summer: {
                    fromMonth: 6, fromDay: 1, toMonth: 9, toDay: 30,
                    tou_periods: {
                        Empty: { periods: null as unknown as [] },
                    },
                },
            },
        };
        expect(parseTariffContent(t, 'Site').seasons[0].schedules).toHaveLength(0);
    });
});

describe('buildDefaultTariff', () => {
    it('has one All Year season', () => {
        expect(buildDefaultTariff().seasons).toHaveLength(1);
        expect(buildDefaultTariff().seasons[0].name).toBe('All Year');
    });

    it('season covers Jan 1 – Dec 31', () => {
        const s = buildDefaultTariff().seasons[0];
        expect(s).toMatchObject({ from_month: 1, from_day: 1, to_month: 12, to_day: 31 });
    });

    it('has one Default schedule covering all days and hours', () => {
        const schedule = buildDefaultTariff().seasons[0].schedules[0];
        expect(schedule).toMatchObject({
            name: 'Default',
            from_day_of_week: 0, to_day_of_week: 6,
            from_hour: 0, to_hour: 24,
        });
    });

    it('uses provided name', () => {
        expect(buildDefaultTariff('My Custom Rate').name).toBe('My Custom Rate');
    });
});
```

- [ ] **Step 2.3: Run tests — verify they fail**

```bash
cd cmd/next-app && npm test -- src/lib/importer/tariff-parser.test.ts
```

Expected: `Error: not implemented`

- [ ] **Step 2.4: Implement**

Replace the stub in `src/lib/importer/tariff-parser.ts`:

```typescript
// src/lib/importer/tariff-parser.ts
import { TariffV2 } from '../tesla-client';

export interface ParsedSchedule {
    name: string;
    buy_rate: number;
    sell_rate: number;
    from_day_of_week: number;
    to_day_of_week: number;
    from_hour: number;
    from_minute: number;
    to_hour: number;
    to_minute: number;
}

export interface ParsedSeason {
    name: string;
    from_month: number;
    from_day: number;
    to_month: number;
    to_day: number;
    buy_rate: number;
    sell_rate: number;
    schedules: ParsedSchedule[];
}

export interface ParsedTariff {
    name: string;
    seasons: ParsedSeason[];
}

export function parseTariffContent(content: TariffV2, siteName: string): ParsedTariff {
    const tariffName = content.utility ?? siteName ?? 'Utility Tariff';
    const seasons: ParsedSeason[] = [];

    for (const seasonName in content.seasons) {
        const seasonData = content.seasons[seasonName];

        let fixedSeasonName = seasonName;
        const sFrom = seasonData.fromMonth;
        if (seasonName.toLowerCase() === 'summer' && (sFrom >= 10 || sFrom <= 2)) {
            fixedSeasonName = 'Winter';
        } else if (seasonName.toLowerCase() === 'winter' && (sFrom >= 5 && sFrom <= 9)) {
            fixedSeasonName = 'Summer';
        }

        const buyRates = content.energy_charges?.[seasonName]?.rates ?? {};
        const sellRates = content.sell_tariff?.energy_charges?.[seasonName]?.rates ?? {};
        const schedules: ParsedSchedule[] = [];

        for (const touName in seasonData.tou_periods) {
            const periodGroup = seasonData.tou_periods[touName];
            if (!periodGroup.periods) continue;

            const buyRate = buyRates[touName] ?? 0;
            const sellRate = sellRates[touName] ?? 0;

            for (const p of periodGroup.periods) {
                schedules.push({
                    name: touName,
                    buy_rate: buyRate,
                    sell_rate: sellRate,
                    from_day_of_week: p.fromDayOfWeek,
                    to_day_of_week: p.toDayOfWeek,
                    from_hour: p.fromHour,
                    from_minute: p.fromMinute,
                    to_hour: p.toHour,
                    to_minute: p.toMinute,
                });
            }
        }

        seasons.push({
            name: fixedSeasonName,
            from_month: seasonData.fromMonth,
            from_day: seasonData.fromDay,
            to_month: seasonData.toMonth,
            to_day: seasonData.toDay,
            buy_rate: 0,
            sell_rate: 0,
            schedules,
        });
    }

    return { name: tariffName, seasons };
}

export function buildDefaultTariff(name: string = 'Default Rate'): ParsedTariff {
    return {
        name,
        seasons: [{
            name: 'All Year',
            from_month: 1, from_day: 1,
            to_month: 12, to_day: 31,
            buy_rate: 0, sell_rate: 0,
            schedules: [{
                name: 'Default',
                buy_rate: 0, sell_rate: 0,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: 0, from_minute: 0,
                to_hour: 24, to_minute: 0,
            }],
        }],
    };
}
```

- [ ] **Step 2.5: Run tests — verify they pass**

```bash
cd cmd/next-app && npm test -- src/lib/importer/tariff-parser.test.ts
```

Expected: all 11 tests pass

- [ ] **Step 2.6: Update `updateTariffs` in `importer.ts` to use the new module**

Add import at the top of `src/lib/importer.ts`:

```typescript
import { parseTariffContent, buildDefaultTariff } from './importer/tariff-parser';
```

Replace the `updateTariffs` private method (lines 464–531) and delete the three `ensureDefault*` helpers (lines 534–574) with this single, cleaner method:

```typescript
private async updateTariffs(client: PoolClient, siteId: string, info: EnergySiteInfo) {
    const parsed = info.tariff_content_v2
        ? parseTariffContent(info.tariff_content_v2, info.site_name ?? 'Utility Tariff')
        : buildDefaultTariff('Default Rate');

    await client.query(`
        INSERT INTO "Tariff"(site_id, name, updated)
        VALUES ($1, $2, NOW())
        ON CONFLICT(site_id, name) DO UPDATE SET name=EXCLUDED.name
    `, [siteId, parsed.name]);

    const tariffRowRes = await client.query(
        `SELECT id FROM "Tariff" WHERE site_id = $1 AND name = $2`,
        [siteId, parsed.name]
    );
    const tariffRow = tariffRowRes.rows[0];

    for (const season of parsed.seasons) {
        await client.query(`
            INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [tariffRow.id, season.name, season.from_month, season.from_day,
            season.to_month, season.to_day, season.buy_rate, season.sell_rate]);

        const seasonRowRes = await client.query(
            `SELECT id FROM "TariffSeason" WHERE tariff_id = $1 AND name = $2`,
            [tariffRow.id, season.name]
        );
        const seasonRow = seasonRowRes.rows[0];

        for (const schedule of season.schedules) {
            await client.query(`
                INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate,
                    from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
                seasonRow.id, schedule.name, schedule.buy_rate, schedule.sell_rate,
                schedule.from_day_of_week, schedule.to_day_of_week,
                schedule.from_hour, schedule.from_minute, schedule.to_hour, schedule.to_minute,
            ]);
        }
    }
}
```

- [ ] **Step 2.7: Build and test**

```bash
cd cmd/next-app && npm run build && npm test
```

Expected: build succeeds, all tests pass

- [ ] **Step 2.8: Commit**

```bash
git add src/lib/importer/tariff-parser.ts src/lib/importer/tariff-parser.test.ts src/lib/importer.ts
git commit -m "refactor: extract tariff-parser module with tests"
```

---

## Task 3: Extract `energy-transformer.ts`

Extracts the transformation logic from `processHistory` (lines 663–735 in the current file, already updated in Task 1). This module also owns the `EnergyDataRow` type, which `index.ts` will later re-export so external call sites are unaffected.

**Files:**
- Create: `src/lib/importer/energy-transformer.ts`
- Create: `src/lib/importer/energy-transformer.test.ts`
- Modify: `src/lib/importer.ts` (replace `processHistory` with a call to `transformEnergyPoints`)

- [ ] **Step 3.1: Create the stub**

```typescript
// src/lib/importer/energy-transformer.ts
import { EnergyHistoryEntry, SoeHistoryEntry } from '../tesla-client';
import { SocSample, buildSocSamples, findNearestSoc } from './soc-interpolation';

export type { SocSample };

export interface EnergyDataRow {
    site_id: string;
    tariff_id: number;
    timestamp: Date;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
    battery_soc: number | null;
}

export interface TransformContext {
    siteId: string;
    getTariffId: (ts: Date) => number | null;
}

export function transformEnergyPoints(
    history: EnergyHistoryEntry[],
    soeHistory: SoeHistoryEntry[],
    period: string,
    requestedDurationHours: number,
    context: TransformContext
): EnergyDataRow[] {
    throw new Error('not implemented');
}
```

- [ ] **Step 3.2: Write failing tests**

```typescript
// src/lib/importer/energy-transformer.test.ts
import { describe, it, expect } from 'vitest';
import { transformEnergyPoints, TransformContext } from './energy-transformer';
import { EnergyHistoryEntry, SoeHistoryEntry } from '../tesla-client';

function makeEntry(overrides: Partial<EnergyHistoryEntry> = {}): EnergyHistoryEntry {
    return {
        timestamp: '2026-01-10T12:00:00.000Z',
        solar_energy_exported: 0,
        generator_energy_exported: 0,
        grid_energy_imported: 0,
        grid_services_energy_imported: 0,
        grid_services_energy_exported: 0,
        grid_energy_exported_from_solar: 0,
        grid_energy_exported_from_generator: 0,
        grid_energy_exported_from_battery: 0,
        battery_energy_exported: 0,
        battery_energy_imported_from_grid: 0,
        battery_energy_imported_from_solar: 0,
        battery_energy_imported_from_generator: 0,
        consumer_energy_imported_from_grid: 0,
        consumer_energy_imported_from_solar: 0,
        consumer_energy_imported_from_battery: 0,
        consumer_energy_imported_from_generator: 0,
        total_home_usage: 0,
        total_solar_generation: 0,
        total_battery_charge: 0,
        total_battery_discharge: 0,
        total_grid_energy_exported: 0,
        ...overrides,
    };
}

const CONTEXT: TransformContext = {
    siteId: 'site-123',
    getTariffId: () => 1,
};

describe('transformEnergyPoints', () => {
    it('maps total_home_usage to load_power', () => {
        const history = [makeEntry({ total_home_usage: 100 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.load_power).toBe(100);
    });

    it('maps total_solar_generation to solar_power', () => {
        const history = [makeEntry({ total_solar_generation: 50 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.solar_power).toBe(50);
    });

    it('uses solar_energy_exported when total_solar_generation is 0', () => {
        const history = [makeEntry({ total_solar_generation: 0, solar_energy_exported: 30 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.solar_power).toBe(30);
    });

    it('sets grid_power positive for grid import', () => {
        const history = [makeEntry({ grid_energy_imported: 200 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.grid_power).toBe(200);
    });

    it('sets grid_power negative for grid export', () => {
        const history = [makeEntry({ grid_energy_imported: 0, total_grid_energy_exported: 150 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.grid_power).toBe(-150);
    });

    it('sets battery_power positive for charge, negative for discharge', () => {
        const charge = [makeEntry({ total_battery_charge: 80, total_battery_discharge: 0 })];
        expect(transformEnergyPoints(charge, [], 'day', 1, CONTEXT)[0].battery_power).toBe(80);

        const discharge = [makeEntry({ total_battery_charge: 0, total_battery_discharge: 40 })];
        expect(transformEnergyPoints(discharge, [], 'day', 1, CONTEXT)[0].battery_power).toBe(-40);
    });

    it('scales load_power by 1000 for full-day aggregates (period=day, duration>20h)', () => {
        // Two entries 24h apart → each entry's durationHours ≈ 24
        const history = [
            makeEntry({ total_home_usage: 64, timestamp: '2026-01-10T00:00:00.000Z' }),
            makeEntry({ total_home_usage: 64, timestamp: '2026-01-11T00:00:00.000Z' }),
        ];
        const rows = transformEnergyPoints(history, [], 'day', 24, CONTEXT);
        expect(rows[0].load_power).toBe(64 * 1000);
    });

    it('does NOT scale for partial-day singleton (period=day, requestedDurationHours<=20)', () => {
        const history = [makeEntry({ total_home_usage: 64 })];
        const [row] = transformEnergyPoints(history, [], 'day', 7, CONTEXT);
        expect(row.load_power).toBe(64);
    });

    it('sets battery_soc from matching SoC sample', () => {
        const ts = '2026-01-10T12:00:00.000Z';
        const history = [makeEntry({ timestamp: ts })];
        const soeHistory: SoeHistoryEntry[] = [{ timestamp: ts, percentage_charged: 75 }];
        const [row] = transformEnergyPoints(history, soeHistory, 'day', 1, CONTEXT);
        expect(row.battery_soc).toBe(75);
    });

    it('sets battery_soc to null when no SoC sample within 5 min', () => {
        const history = [makeEntry({ timestamp: '2026-01-10T12:00:00.000Z' })];
        const soeHistory: SoeHistoryEntry[] = [
            { timestamp: '2026-01-10T11:50:00.000Z', percentage_charged: 60 },
        ];
        const [row] = transformEnergyPoints(history, soeHistory, 'day', 1, CONTEXT);
        expect(row.battery_soc).toBeNull();
    });

    it('skips entries when getTariffId returns null', () => {
        const ctx: TransformContext = { siteId: 'site-123', getTariffId: () => null };
        const history = [makeEntry()];
        expect(transformEnergyPoints(history, [], 'day', 1, ctx)).toHaveLength(0);
    });

    it('sets site_id and tariff_id from context', () => {
        const ctx: TransformContext = { siteId: 'my-site', getTariffId: () => 42 };
        const [row] = transformEnergyPoints([makeEntry()], [], 'day', 1, ctx);
        expect(row.site_id).toBe('my-site');
        expect(row.tariff_id).toBe(42);
    });
});
```

- [ ] **Step 3.3: Run tests — verify they fail**

```bash
cd cmd/next-app && npm test -- src/lib/importer/energy-transformer.test.ts
```

Expected: `Error: not implemented`

- [ ] **Step 3.4: Implement**

Replace the stub in `src/lib/importer/energy-transformer.ts`:

```typescript
// src/lib/importer/energy-transformer.ts
import { EnergyHistoryEntry, SoeHistoryEntry } from '../tesla-client';
import { buildSocSamples, findNearestSoc, SocSample } from './soc-interpolation';

export type { SocSample };

export interface EnergyDataRow {
    site_id: string;
    tariff_id: number;
    timestamp: Date;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
    battery_soc: number | null;
}

export interface TransformContext {
    siteId: string;
    getTariffId: (ts: Date) => number | null;
}

export function transformEnergyPoints(
    history: EnergyHistoryEntry[],
    soeHistory: SoeHistoryEntry[],
    period: string,
    requestedDurationHours: number,
    context: TransformContext
): EnergyDataRow[] {
    const socSamples = buildSocSamples(soeHistory);
    const results: EnergyDataRow[] = [];

    for (let i = 0; i < history.length; i++) {
        const h = history[i];
        const ts = new Date(h.timestamp);

        let durationHours = 24;
        if (i < history.length - 1) {
            const nextTs = new Date(history[i + 1].timestamp).getTime();
            durationHours = (nextTs - ts.getTime()) / (3600 * 1000);
        } else if (i > 0) {
            const prevTs = new Date(history[i - 1].timestamp).getTime();
            durationHours = (ts.getTime() - prevTs) / (3600 * 1000);
        }

        const shouldScaleDailyAggregate =
            period === 'day' && requestedDurationHours > 20 && durationHours > 20;
        const scale = shouldScaleDailyAggregate ? 1000 : 1;

        const hSolar = (h.total_solar_generation || h.solar_energy_exported) ?? 0;
        const hHome = h.total_home_usage ?? 0;

        const tariffId = context.getTariffId(ts);
        if (tariffId === null) continue;

        const gridImported = h.grid_energy_imported ?? 0;
        const gridExported = h.total_grid_energy_exported ?? 0;
        const grid = gridImported !== 0 ? gridImported : -gridExported;

        const batteryCharge = h.total_battery_charge ?? 0;
        const batteryDischarge = h.total_battery_discharge ?? 0;
        const battery = batteryCharge !== 0 ? batteryCharge : -batteryDischarge;

        results.push({
            site_id: context.siteId,
            tariff_id: tariffId,
            timestamp: ts,
            load_power: hHome * scale,
            solar_power: hSolar * scale,
            grid_power: grid * scale,
            battery_power: battery * scale,
            battery_soc: findNearestSoc(socSamples, ts.getTime()),
        });
    }

    return results;
}
```

- [ ] **Step 3.5: Run tests — verify they pass**

```bash
cd cmd/next-app && npm test -- src/lib/importer/energy-transformer.test.ts
```

Expected: all 12 tests pass

- [ ] **Step 3.6: Update `processHistory` in `importer.ts` to delegate to `transformEnergyPoints`**

Add this import at the top of `src/lib/importer.ts`:

```typescript
import { transformEnergyPoints } from './importer/energy-transformer';
```

Remove the existing import of `buildSocSamples, findNearestSoc` added in Task 1 (they are now used inside `energy-transformer`).

Replace the `processHistory` private method with:

```typescript
private async processHistory(
    _client: PoolClient,
    site: SiteWithTariffs,
    history: EnergyHistoryEntry[],
    soeHistory: SoeHistoryEntry[],
    period: string = 'day',
    requestedDurationHours: number = 24
): Promise<EnergyDataRow[]> {
    const schedule = new Schedule(site.tariffs, site.timezone);
    return transformEnergyPoints(history, soeHistory, period, requestedDurationHours, {
        siteId: site.id,
        getTariffId: (ts: Date) => {
            const tp = this.getTariffPeriodOrFallback(site, schedule, ts);
            return tp ? Number(tp.tariff.id) : null;
        },
    });
}
```

Also update the `EnergyDataRow` import at the top of `importer.ts`: remove the local `export interface EnergyDataRow` definition and instead re-export from the new module:

```typescript
export type { EnergyDataRow } from './importer/energy-transformer';
```

- [ ] **Step 3.7: Build and test**

```bash
cd cmd/next-app && npm run build && npm test
```

Expected: build succeeds, all tests pass

- [ ] **Step 3.8: Commit**

```bash
git add src/lib/importer/energy-transformer.ts src/lib/importer/energy-transformer.test.ts src/lib/importer.ts
git commit -m "refactor: extract energy-transformer module with tests"
```

---

## Task 4: Extract `import-planner.ts`

Extracts the gap detection loop from `ensureDataForRange` (lines 196–282) and the UTC midnight chunking from `importRange` (lines 305–328) into pure functions. `import-planner.ts` imports `EnergyRepo.getSiteMidnight` — that's acceptable because it's a pure static method with no DB side effects.

**Files:**
- Create: `src/lib/importer/import-planner.ts`
- Create: `src/lib/importer/import-planner.test.ts`
- Modify: `src/lib/importer.ts` (`ensureDataForRange` and `importRange` delegate to new functions)

- [ ] **Step 4.1: Create the stub**

```typescript
// src/lib/importer/import-planner.ts
import { EnergyRepo } from '../energy-repo';

export interface DateWindow {
    start: Date;
    end: Date;
}

export interface PlanOptions {
    requestedRange: DateWindow;
    existingTimestamps: number[];
    timezone: string;
    installationDate?: Date;
    forceRefetch?: boolean;
    gapThresholdMs?: number;
    now?: Date;
}

export function planImport(options: PlanOptions): DateWindow[] {
    throw new Error('not implemented');
}

export function splitAtUtcMidnight(window: DateWindow): DateWindow[] {
    throw new Error('not implemented');
}
```

- [ ] **Step 4.2: Write failing tests**

```typescript
// src/lib/importer/import-planner.test.ts
import { describe, it, expect } from 'vitest';
import { planImport, splitAtUtcMidnight } from './import-planner';

// America/Chicago is UTC-6 in winter, so site midnight = 06:00 UTC
const TZ = 'America/Chicago';
const DAY1_START = new Date('2026-01-10T06:00:00.000Z'); // midnight Chicago
const DAY1_END = new Date('2026-01-11T06:00:00.000Z');   // midnight next day
const FUTURE = new Date('2026-01-12T12:00:00.000Z');

function fiveMinTicks(from: Date, to: Date): number[] {
    const ticks: number[] = [];
    let t = from.getTime();
    while (t < to.getTime()) {
        ticks.push(t);
        t += 5 * 60 * 1000;
    }
    return ticks;
}

describe('planImport', () => {
    it('returns a window for a day with no existing data', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns no windows when day is fully covered', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: fiveMinTicks(DAY1_START, DAY1_END),
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(0);
    });

    it('returns a window when gap at start exceeds threshold', () => {
        // Only one point, 1 hour into the day — gap at start
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: [DAY1_START.getTime() + 60 * 60 * 1000],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns a window when gap at end exceeds threshold', () => {
        // Only one point, 1 hour before end of day — gap at end
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: [DAY1_END.getTime() - 60 * 60 * 1000],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('returns window even when fully covered if forceRefetch is true', () => {
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY1_END },
            existingTimestamps: fiveMinTicks(DAY1_START, DAY1_END),
            timezone: TZ,
            forceRefetch: true,
            now: FUTURE,
        });
        expect(result).toHaveLength(1);
    });

    it('clamps start to installationDate', () => {
        const result = planImport({
            requestedRange: { start: new Date('2026-01-01T06:00:00.000Z'), end: DAY1_END },
            existingTimestamps: [],
            timezone: TZ,
            installationDate: DAY1_START,
            now: FUTURE,
        });
        result.forEach(w => {
            expect(w.start.getTime()).toBeGreaterThanOrEqual(DAY1_START.getTime());
        });
    });

    it('returns two windows for two days each missing data', () => {
        const DAY2_START = new Date('2026-01-11T06:00:00.000Z');
        const DAY2_END = new Date('2026-01-12T06:00:00.000Z');
        const result = planImport({
            requestedRange: { start: DAY1_START, end: DAY2_END },
            existingTimestamps: [],
            timezone: TZ,
            now: FUTURE,
        });
        expect(result).toHaveLength(2);
    });
});

describe('splitAtUtcMidnight', () => {
    it('returns a single window that does not cross UTC midnight', () => {
        const w = {
            start: new Date('2026-01-10T06:00:00.000Z'),
            end: new Date('2026-01-10T20:00:00.000Z'),
        };
        expect(splitAtUtcMidnight(w)).toHaveLength(1);
    });

    it('splits a window crossing UTC midnight into two chunks', () => {
        const w = {
            start: new Date('2026-01-10T20:00:00.000Z'),
            end: new Date('2026-01-11T04:00:00.000Z'),
        };
        const result = splitAtUtcMidnight(w);
        expect(result).toHaveLength(2);
        // First chunk ends at 23:59:59.999 UTC
        expect(result[0].end.getUTCHours()).toBe(23);
        expect(result[0].end.getUTCMinutes()).toBe(59);
        // Second chunk starts at 00:00:00 UTC
        expect(result[1].start.getUTCHours()).toBe(0);
        expect(result[1].start.getUTCMinutes()).toBe(0);
    });

    it('preserves start and end of the original window across chunks', () => {
        const start = new Date('2026-01-10T20:00:00.000Z');
        const end = new Date('2026-01-11T04:00:00.000Z');
        const result = splitAtUtcMidnight({ start, end });
        expect(result[0].start.getTime()).toBe(start.getTime());
        expect(result[result.length - 1].end.getTime()).toBe(end.getTime());
    });

    it('splits a 48h window into three chunks', () => {
        const w = {
            start: new Date('2026-01-10T06:00:00.000Z'),
            end: new Date('2026-01-12T06:00:00.000Z'),
        };
        expect(splitAtUtcMidnight(w)).toHaveLength(3);
    });
});
```

- [ ] **Step 4.3: Run tests — verify they fail**

```bash
cd cmd/next-app && npm test -- src/lib/importer/import-planner.test.ts
```

Expected: `Error: not implemented`

- [ ] **Step 4.4: Implement**

Replace the stub in `src/lib/importer/import-planner.ts`:

```typescript
// src/lib/importer/import-planner.ts
import { EnergyRepo } from '../energy-repo';

export interface DateWindow {
    start: Date;
    end: Date;
}

export interface PlanOptions {
    requestedRange: DateWindow;
    existingTimestamps: number[];
    timezone: string;
    installationDate?: Date;
    forceRefetch?: boolean;
    gapThresholdMs?: number;
    now?: Date;
}

export function planImport(options: PlanOptions): DateWindow[] {
    const {
        requestedRange,
        existingTimestamps,
        timezone,
        installationDate,
        forceRefetch = false,
        gapThresholdMs = 30 * 60 * 1000,
        now = new Date(),
    } = options;

    const windows: DateWindow[] = [];
    let cursor = EnergyRepo.getSiteMidnight(requestedRange.start, timezone);

    if (installationDate) {
        const installMidnight = EnergyRepo.getSiteMidnight(installationDate, timezone);
        if (cursor.getTime() < installMidnight.getTime()) {
            cursor = installMidnight;
        }
    }

    const todayStart = EnergyRepo.getSiteMidnight(now, timezone);
    let tsIndex = 0;

    while (cursor.getTime() <= requestedRange.end.getTime()) {
        const windowStart = cursor.getTime();
        const nextDay = EnergyRepo.getSiteMidnight(
            new Date(windowStart + 30 * 60 * 60 * 1000),
            timezone
        );
        const windowEnd = nextDay.getTime();
        const isToday = cursor.getTime() === todayStart.getTime();

        while (tsIndex < existingTimestamps.length && existingTimestamps[tsIndex] < windowStart) {
            tsIndex++;
        }

        let firstInWindow: number | null = null;
        let lastInWindow: number | null = null;
        let tempIdx = tsIndex;
        while (tempIdx < existingTimestamps.length && existingTimestamps[tempIdx] < windowEnd) {
            if (firstInWindow === null) firstInWindow = existingTimestamps[tempIdx];
            lastInWindow = existingTimestamps[tempIdx];
            tempIdx++;
        }

        const hasAnyData = firstInWindow !== null;
        const importEnd = isToday ? now : nextDay;

        if (!hasAnyData || forceRefetch) {
            windows.push({ start: cursor, end: importEnd });
        } else {
            const missingStart = firstInWindow! - windowStart > gapThresholdMs;
            const effectiveEnd = isToday ? now.getTime() : windowEnd;
            const missingEnd = effectiveEnd - lastInWindow! > gapThresholdMs;

            if (missingStart || missingEnd) {
                windows.push({ start: cursor, end: importEnd });
            }
        }

        cursor = nextDay;
    }

    return windows;
}

export function splitAtUtcMidnight(window: DateWindow): DateWindow[] {
    const results: DateWindow[] = [];
    let cursor = new Date(window.start);

    while (cursor < window.end) {
        const utcEndOfDay = new Date(cursor.getTime());
        utcEndOfDay.setUTCHours(23, 59, 59, 999);
        const nextUtcMidnight = new Date(utcEndOfDay.getTime() + 1);

        const chunkEnd = nextUtcMidnight < window.end ? nextUtcMidnight : window.end;
        results.push({ start: new Date(cursor), end: new Date(chunkEnd) });
        cursor = new Date(chunkEnd);
    }

    return results;
}
```

- [ ] **Step 4.5: Run tests — verify they pass**

```bash
cd cmd/next-app && npm test -- src/lib/importer/import-planner.test.ts
```

Expected: all 10 tests pass

- [ ] **Step 4.6: Update `ensureDataForRange` and `importRange` in `importer.ts`**

Add imports at the top of `src/lib/importer.ts`:

```typescript
import { planImport, splitAtUtcMidnight, DateWindow } from './importer/import-planner';
```

Replace `importRange` (lines 294–328) with:

```typescript
async importRange(siteId: string, start: Date, end: Date, period: string = 'day', onProgress?: (date: Date) => void): Promise<EnergyDataRow[]> {
    const allRows: EnergyDataRow[] = [];
    const site = await this.repo.getSite(siteId);
    if (!site) {
        console.error(`Site ${siteId} not found for importRange`);
        throw new Error(`Site ${siteId} not found in database`);
    }

    for (const chunk of splitAtUtcMidnight({ start, end })) {
        if (onProgress) onProgress(chunk.start);
        const rows = await this.loadInterval(site, chunk.start, chunk.end, period);
        allRows.push(...rows);
    }
    return allRows;
}
```

Replace the inner loop of `ensureDataForRange` (lines ~196–279) with `planImport`. The method becomes:

```typescript
async ensureDataForRange(siteId: string, start: Date, end: Date, onProgress?: (msg: string) => void, options?: { force?: boolean }): Promise<EnergyDataRow[]> {
    const force = options?.force ?? false;
    if (Importer.pendingSyncs.has(siteId) && !force) {
        logSync(`Skip: Data for range already being synced for site ${siteId}`);
        return [];
    }
    if (!force) Importer.pendingSyncs.add(siteId);
    logSync(`Audit Start: ${siteId}, Range: ${start.toISOString()} to ${end.toISOString()}, force=${force}`);

    try {
        if (onProgress) onProgress(`Checking data coverage...`);
        const site = await this.repo.getSite(siteId);
        if (!site) throw new Error(`Site ${siteId} not found in database`);

        const rowsRes = await pool.query(`
            SELECT timestamp FROM "EnergyData"
            WHERE site_id = $1
            AND timestamp >= $2
            AND timestamp < $3
            ORDER BY timestamp ASC
        `, [siteId, start.toISOString(), end.toISOString()]);

        const existingTimestamps = rowsRes.rows.map(
            (r: { timestamp: string | Date }) => new Date(r.timestamp).getTime()
        );

        const windows = planImport({
            requestedRange: { start, end },
            existingTimestamps,
            timezone: site.timezone,
            installationDate: new Date(site.installed),
            forceRefetch: force,
        });

        const allRows: EnergyDataRow[] = [];
        for (const window of windows) {
            const dateStr = window.start.toISOString().split('T')[0];
            if (onProgress) onProgress(`Importing ${dateStr}...`);
            logSync(`Importing window: ${window.start.toISOString()} - ${window.end.toISOString()}`);
            const rows = await this.importRange(siteId, window.start, window.end, 'day');
            allRows.push(...rows);
        }

        Importer.maintenanceCache.set(siteId, Date.now());
        return allRows;
    } finally {
        Importer.pendingSyncs.delete(siteId);
    }
}
```

- [ ] **Step 4.7: Build and test**

```bash
cd cmd/next-app && npm run build && npm test
```

Expected: build succeeds, all tests pass

- [ ] **Step 4.8: Commit**

```bash
git add src/lib/importer/import-planner.ts src/lib/importer/import-planner.test.ts src/lib/importer.ts
git commit -m "refactor: extract import-planner module with tests"
```

---

## Task 5: Move `Importer` to `importer/index.ts`, replace `importer.ts` with shim

At this point `importer.ts` contains only the `Importer` class (shell), the `EnergyDataRow` re-export, and imports. Moving it into the directory completes the restructure. External call sites never change.

**Files:**
- Create: `src/lib/importer/index.ts` (Importer class, moved from `importer.ts`)
- Modify: `src/lib/importer.ts` (replace with one-line shim)

- [ ] **Step 5.1: Create `src/lib/importer/index.ts`**

Copy the current contents of `src/lib/importer.ts` into `src/lib/importer/index.ts`.

Update its imports to use relative paths one level up:

```typescript
// At the top of src/lib/importer/index.ts, replace:
import { pool, SiteWithTariffs, TariffSeason, TariffSchedule } from './db';
import { Schedule } from './schedule';
import { TeslaClient, EnergyHistoryEntry, EnergySiteInfo, SoeHistoryEntry } from './tesla-client';
import { EnergyRepo } from './energy-repo';
import { UserRepo } from './user-repo';
import { buildSocSamples, findNearestSoc } from './importer/soc-interpolation';
import { parseTariffContent, buildDefaultTariff } from './importer/tariff-parser';
import { transformEnergyPoints } from './importer/energy-transformer';
import { planImport, splitAtUtcMidnight, DateWindow } from './importer/import-planner';
// with:
import { pool, SiteWithTariffs, TariffSeason, TariffSchedule } from '../db';
import { Schedule } from '../schedule';
import { TeslaClient, EnergyHistoryEntry, EnergySiteInfo, SoeHistoryEntry } from '../tesla-client';
import { EnergyRepo } from '../energy-repo';
import { UserRepo } from '../user-repo';
import { parseTariffContent, buildDefaultTariff } from './tariff-parser';
import { transformEnergyPoints } from './energy-transformer';
import { planImport, splitAtUtcMidnight, DateWindow } from './import-planner';
```

Also update the `EnergyDataRow` export at the top:

```typescript
export type { EnergyDataRow } from './energy-transformer';
```

- [ ] **Step 5.2: Replace `src/lib/importer.ts` with the shim**

```typescript
// src/lib/importer.ts
export * from './importer/index';
```

- [ ] **Step 5.3: Build and test**

```bash
cd cmd/next-app && npm run build && npm test
```

Expected: build succeeds, all tests pass. Verify `src/lib/importer/index.ts` is under 400 lines:

```bash
wc -l cmd/next-app/src/lib/importer/index.ts
```

Expected: ≤ 400

- [ ] **Step 5.4: Confirm no imports bypass the shim**

```bash
grep -r "from.*importer/" cmd/next-app/src/app cmd/next-app/src/components 2>/dev/null
```

Expected: no output (all call sites import from `'../lib/importer'`, not sub-modules directly)

- [ ] **Step 5.5: Commit**

```bash
git add src/lib/importer/index.ts src/lib/importer.ts
git commit -m "refactor: move Importer shell to importer/index.ts, replace importer.ts with shim"
```
