import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { safeActivityTestSocket } from './battery-hold-activity-test-db';
import { createTariffTestDatabase } from './tariff-test-db';

const local = vi.hoisted(() => ({ database: undefined as unknown as Pool }));
vi.mock('./db', () => ({
  pool: {
    query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
    connect: () => local.database.connect(),
  },
}));
vi.mock('./energy-repo-factory', () => ({
  createEnergyRepo: () => ({ getCycleAggregates: async () => [] }),
}));

import type { Tariff } from './db';
import { isObservedHoliday } from './holidays';
import type { ParsedTariff } from './importer/tariff-parser';
import { Schedule } from './schedule';
import type {
  TariffAlignedSeasonComparison,
  TariffComparisonSlotRate,
  TariffSeasonInput,
  TariffSelectionPreviewResponse,
  TariffSelectionRequest,
} from './tariff-contract';
import { TariffRepo } from './tariff-repo';
import { commitTariffSelection, previewTariffSelection } from './tariff-selection-service';
import { addCalendarDays } from './tariff-timeline';
import { TariffTimelineRepo } from './tariff-timeline-repo';
import { runUrdbEstimatesForSite, type UrdbApi } from './urdb/estimate-job';
import type { UrdbRate } from './urdb/types';

/**
 * The review promises what a change will do; this suite checks every promise against what the
 * commit actually writes and how billing (`resolveTariffForDate` + `Schedule`) then prices each
 * day. For each scenario it previews a change, snapshots billing, commits, snapshots again, and
 * compares:
 *   1. each review interval's before and after rates with billing before and after, hour by hour;
 *   2. every day whose billing changed lies inside a review interval or the recalculation range;
 *   3. the recalculation range equals the re-attribution job the commit queued;
 *   4. periods the review calls unchanged keep their billing.
 * A difference fails with the date, hour and both rates, rather than waiting for a reviewer.
 */

const TZ = 'America/Chicago';
const TODAY = '2026-11-16';
const WINDOW_START = '2023-06-01';
const WINDOW_END = '2027-12-31';
const SAMPLE_HOURS = [0, 7, 12, 17, 22];

type Rate = { buy: number; sell: number } | null;
type BillingSnapshot = Map<string, Tariff[]>;

const flatSeasons = (buy: number, sell = 0.04): TariffSeasonInput[] => [{
  name: 'All Year',
  fromMonth: 1,
  toMonth: 12,
  weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: buy, sellRate: sell }],
  weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: buy, sellRate: sell }],
}];

/** Summer peak 16–21 on weekdays, so seasons and time windows both get exercised. */
const touSeasons = (peak: number, offPeak: number): TariffSeasonInput[] => [
  {
    name: 'Summer', fromMonth: 6, toMonth: 9,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 16, toMinute: 0, buyRate: offPeak, sellRate: 0.03 },
      { touName: 'ON_PEAK', fromHour: 16, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: peak, sellRate: 0.05 },
      { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: offPeak, sellRate: 0.03 },
    ],
    weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: offPeak, sellRate: 0.03 }],
  },
  {
    name: 'Winter', fromMonth: 10, toMonth: 5,
    weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: offPeak, sellRate: 0.03 }],
    weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: offPeak, sellRate: 0.03 }],
  },
];

/** A Tesla plan with whole-day rules: `weekdays` Tesla days (0 = Monday) at `buy`, the rest at `otherBuy`. */
function teslaPlan(name: string, buy: number, otherBuy = buy, days: [number, number] = [0, 6]): ParsedTariff {
  const schedules = [
    { name: 'OFF_PEAK', buy_rate: buy, sell_rate: 0.03, from_day_of_week: days[0], to_day_of_week: days[1], from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
  ];
  if (days[0] !== 0 || days[1] !== 6) {
    const rest: [number, number] = days[0] === 0 ? [days[1] + 1, 6] : [0, days[0] - 1];
    schedules.push({ name: 'ON_PEAK', buy_rate: otherBuy, sell_rate: 0.03, from_day_of_week: rest[0], to_day_of_week: rest[1], from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 });
  }
  return {
    name,
    seasons: [{ name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: buy, sell_rate: 0.03, schedules }],
  } as ParsedTariff;
}

function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addCalendarDays(day, 1)) days.push(day);
  return days;
}

function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function billingRate(tariffs: Tariff[] | undefined, day: string, hour: number): Rate {
  if (!tariffs || tariffs.length === 0) return null;
  const [y, m, d] = day.split('-').map(Number);
  const period = new Schedule(tariffs, TZ).getTariffPeriodByComponents(m, d, hour, weekdayOf(day), undefined, y, 30);
  if (!period) return null;
  return { buy: period.schedule.buy_rate ?? period.season.buy_rate, sell: period.schedule.sell_rate ?? period.season.sell_rate };
}

function seasonContains(season: TariffAlignedSeasonComparison, day: string): boolean {
  const [, m, d] = day.split('-').map(Number);
  const key = m * 100 + d;
  const from = season.fromMonth * 100 + season.fromDay;
  const to = season.toMonth * 100 + season.toDay;
  return from <= to ? key >= from && key <= to : key >= from || key <= to;
}

function reviewRate(
  seasons: TariffAlignedSeasonComparison[], side: 'before' | 'after', day: string, hour: number,
  holidaysUseWeekend: boolean
): Rate {
  const season = seasons.find(s => seasonContains(s, day));
  if (!season) return null;
  const [y, m, d] = day.split('-').map(Number);
  const weekday = weekdayOf(day);
  const weekend = weekday === 0 || weekday === 6 || (holidaysUseWeekend && isObservedHoliday(y, m, d));
  const minute = hour * 60 + 30;
  const row = (weekend ? season.weekendRows : season.weekdayRows).find(r =>
    r.fromHour * 60 + r.fromMinute <= minute && minute < r.toHour * 60 + r.toMinute);
  const slot: TariffComparisonSlotRate | null | undefined = row?.[side];
  return slot ? { buy: slot.buyRate, sell: slot.sellRate } : null;
}

const sameRate = (a: Rate, b: Rate) =>
  a === b || (a !== null && b !== null && Math.abs(a.buy - b.buy) < 1e-6 && Math.abs(a.sell - b.sell) < 1e-6);

const inRange = (day: string, from: string, to: string | null) => day >= from && (to === null || day <= to);

const flatRate = (label: string, date: string, buy: number, supersedes?: string): UrdbRate => {
  const schedule = Array.from({ length: 12 }, () => Array(24).fill(0));
  return {
    label, name: `Plan ${label}`, utility: 'Wisconsin Electric Power Co',
    startdate: Date.parse(`${date}T00:00:00Z`) / 1000, supersedes,
    energyratestructure: [[{ rate: buy }]], energyweekdayschedule: schedule, energyweekendschedule: schedule,
  };
};
const chainApi = (rates: UrdbRate[]): UrdbApi => ({
  utilityNames: async () => ['Wisconsin Electric Power Co'],
  ratesEffectiveOn: async () => rates.filter(rate => !rates.some(other => other.supersedes === rate.label)),
  rateByLabel: async label => rates.find(rate => rate.label === label) ?? null,
  defaultRates: async () => [],
});

describe.skipIf(!safeActivityTestSocket)('rate plan review matches what the commit and billing do (postgres)', () => {
  const repo = new TariffTimelineRepo();
  const tariffRepo = new TariffRepo();
  let siteCounter = 0;

  beforeAll(async () => {
    local.database = await createTariffTestDatabase('tariff_selection_audit_test');
    // Columns the estimate job reads; the main tariff suite adds them partway through.
    await local.database.query(
      'ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS utility TEXT, ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ'
    );
  });
  afterAll(async () => {
    if (local.database) await local.database.end();
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T18:00:00Z`) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function newSite(): Promise<string> {
    siteCounter += 1;
    const siteId = `s-audit-${siteCounter}`;
    await local.database.query(
      `INSERT INTO "Site"(id, user_id, timezone, json) VALUES ($1, 'u1', $2, '{"currency":"USD"}')`,
      [siteId, TZ]
    );
    return siteId;
  }

  /** A US site whose owner picked a public plan; the estimate job fills it from public rates. */
  async function estimatedSite(rates: UrdbRate[], picked: string): Promise<string> {
    const siteId = await newSite();
    await local.database.query(
      `UPDATE "Site" SET utility = 'We Energies', rate_country = 'US', rate_country_source = 'owner' WHERE id = $1`, [siteId]
    );
    await local.database.query(
      `INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, urdb_plan_label, status)
       VALUES ($1, 'Wisconsin Electric Power Co', 'owner', $2, 'pending')`, [siteId, picked]
    );
    await runUrdbEstimatesForSite(siteId, chainApi(rates), new Date(`${TODAY}T12:00:00Z`));
    const spans = await local.database.query<{ source: string; effective_from: string; effective_to: string | null }>(
      `SELECT source, effective_from::text, effective_to::text FROM "TariffEffectivePeriod"
       WHERE site_id = $1 ORDER BY effective_from`, [siteId]
    );
    expect(spans.rows.map(row => [row.source, row.effective_from, row.effective_to])).toEqual([
      ['estimated', '2024-01-01', '2025-06-30'],
      ['estimated', '2025-07-01', null],
    ]);
    return siteId;
  }

  async function manual(siteId: string, name: string, from: string, to: string | null, seasons: TariffSeasonInput[]) {
    await repo.createManualPeriod(siteId, 'u1', { name, effectiveFrom: from, effectiveTo: to, seasons });
  }

  /** Saves a Tesla plan the way an import does, then dates its period. */
  async function tesla(siteId: string, plan: ParsedTariff, from: string, to: string | null) {
    await tariffRepo.addTariffVersion(siteId, plan);
    const { rows } = await local.database.query<{ id: number }>(
      `SELECT id FROM "Tariff" WHERE site_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1`, [siteId, plan.name]
    );
    await local.database.query(
      `UPDATE "TariffEffectivePeriod" SET effective_from = $3::date, effective_to = $4::date
       WHERE site_id = $1 AND tariff_id = $2`,
      [siteId, rows[0].id, from, to]
    );
  }

  async function snapshot(siteId: string, days: string[]): Promise<BillingSnapshot> {
    const out: BillingSnapshot = new Map();
    for (const day of days) out.set(day, (await repo.resolveTariffForDate(local.database, siteId, day)).tariffs);
    return out;
  }

  function sampleDays(preview: TariffSelectionPreviewResponse): string[] {
    const days = new Set<string>();
    for (let day = WINDOW_START; day <= WINDOW_END; day = addCalendarDays(day, 5)) days.add(day);
    const edges = [
      ...preview.affectedIntervals.flatMap(i => [i.effectiveFrom, i.effectiveTo]),
      ...preview.unchangedOutsidePeriods.flatMap(p => [p.effectiveFrom, p.effectiveTo]),
      preview.recalculationRange?.fromDate ?? null,
      preview.recalculationRange?.toDate ?? null,
    ];
    for (const edge of edges) {
      if (!edge || edge < WINDOW_START || edge > WINDOW_END) continue;
      for (const offset of [-1, 0, 1]) days.add(addCalendarDays(edge, offset));
    }
    // Holidays bill as weekends, which the review shows as a weekend row.
    for (const day of ['2024-07-04', '2024-12-25', '2025-01-01', '2025-05-26', '2025-07-04', '2025-09-01',
      '2025-11-27', '2025-12-25', '2026-07-03', '2026-09-07']) days.add(day);
    // A week inside each interval, so every weekday is checked at least once.
    for (const interval of preview.affectedIntervals) {
      const start = interval.effectiveFrom < WINDOW_START ? WINDOW_START : interval.effectiveFrom;
      for (const day of eachDay(start, addCalendarDays(start, 6))) days.add(day);
    }
    return [...days].filter(day => day >= WINDOW_START && day <= WINDOW_END).sort();
  }

  /** Previews `request`, commits exactly that review, and returns every difference found. */
  async function audit(siteId: string, request: TariffSelectionRequest): Promise<{
    preview: TariffSelectionPreviewResponse;
    problems: string[];
  }> {
    const deps = { now: () => new Date(), repo };
    const preview = await previewTariffSelection(siteId, 'u1', request, deps);
    const days = sampleDays(preview);
    const before = await snapshot(siteId, days);
    await local.database.query(`DELETE FROM "SiteTariffReattribution" WHERE site_id = $1`, [siteId]);
    await commitTariffSelection(siteId, 'u1', {
      ...request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false,
    }, deps);
    const after = await snapshot(siteId, days);

    const problems: string[] = [];
    const daySpecific = preview.approximationNotes.some(n => n.kind === 'day_specific_schedule');
    const actual = preview.scope === 'actual';
    const holidays = preview.holidaysUseWeekendSchedule;

    for (const day of days) {
      const interval = preview.affectedIntervals.find(i => inRange(day, i.effectiveFrom, i.effectiveTo));
      let changed = false;
      for (const hour of SAMPLE_HOURS) {
        const billedBefore = billingRate(before.get(day), day, hour);
        const billedAfter = billingRate(after.get(day), day, hour);
        if (!sameRate(billedBefore, billedAfter)) changed = true;
        if (!interval || !actual) continue;
        const shownBefore = reviewRate(interval.seasons, 'before', day, hour, holidays);
        const shownAfter = reviewRate(interval.seasons, 'after', day, hour, holidays);
        if (!sameRate(shownBefore, billedBefore) && !daySpecific) {
          problems.push(`${day} ${hour}:30 before: review ${JSON.stringify(shownBefore)} vs billing ${JSON.stringify(billedBefore)} (${interval.kind})`);
        }
        if (!sameRate(shownAfter, billedAfter) && !daySpecific) {
          problems.push(`${day} ${hour}:30 after: review ${JSON.stringify(shownAfter)} vs billing ${JSON.stringify(billedAfter)} (${interval.kind})`);
        }
      }
      if (!changed) continue;
      if (!actual) {
        problems.push(`${day}: billing changed for a fixed comparison plan change`);
        continue;
      }
      const range = preview.recalculationRange;
      const covered = interval !== undefined || (range !== null && inRange(day, range.fromDate, range.toDate));
      if (!covered) problems.push(`${day}: billing changed outside every review interval and the recalculation range`);
      if (day <= TODAY && !preview.recalculatesHistory) problems.push(`${day}: billing changed but the review says no past bills change`);
      if (day <= TODAY && range !== null && !inRange(day, range.fromDate, range.toDate)) {
        problems.push(`${day}: billing changed outside the recalculation range ${range.fromDate}..${range.toDate}`);
      }
      const unchanged = preview.unchangedOutsidePeriods.find(p => inRange(day, p.effectiveFrom, p.effectiveTo));
      if (unchanged) problems.push(`${day}: billing changed inside a period the review keeps unchanged`);
    }

    const job = (await local.database.query<{ from_date: string; to_date: string | null }>(
      `SELECT from_date::text, to_date::text FROM "SiteTariffReattribution" WHERE site_id = $1`, [siteId]
    )).rows[0];
    const range = preview.recalculationRange;
    if (actual && range) {
      const jobTo = job?.to_date && job.to_date <= TODAY ? job.to_date : null;
      if (!job) problems.push(`review recalculates ${range.fromDate}..${range.toDate} but no job was queued`);
      else if (job.from_date !== range.fromDate || jobTo !== range.toDate) {
        problems.push(`review recalculates ${range.fromDate}..${range.toDate}, job covers ${job.from_date}..${job.to_date}`);
      }
    } else if (job && job.from_date <= TODAY) {
      problems.push(`review recalculates nothing, but a job covers ${job.from_date}..${job.to_date}`);
    }
    return { preview, problems };
  }

  const manualRequest = (from: string, to: string | null, seasons: TariffSeasonInput[], name = 'Owner Plan'): TariffSelectionRequest => ({
    scope: 'actual', candidate: { kind: 'manual', name, seasons }, effectiveFrom: from, effectiveTo: to,
  });

  it('replaces the middle of one plan', async () => {
    const siteId = await newSite();
    await manual(siteId, 'Base', '2024-01-01', null, touSeasons(0.3, 0.1));
    const { problems } = await audit(siteId, manualRequest('2025-03-01', '2025-08-31', flatSeasons(0.2)));
    expect(problems).toEqual([]);
  });

  it('spans two plans and the gap between them', async () => {
    const siteId = await newSite();
    await manual(siteId, 'Early', '2024-01-01', '2024-12-31', touSeasons(0.3, 0.1));
    await manual(siteId, 'Late', '2025-06-01', null, flatSeasons(0.18));
    const { problems } = await audit(siteId, manualRequest('2024-10-01', '2025-09-30', touSeasons(0.4, 0.12)));
    expect(problems).toEqual([]);
  });

  it('fills a gap between plans', async () => {
    const siteId = await newSite();
    await manual(siteId, 'Early', '2024-01-01', '2024-12-31', touSeasons(0.3, 0.1));
    await manual(siteId, 'Late', '2025-06-01', null, flatSeasons(0.18));
    const { problems } = await audit(siteId, manualRequest('2025-01-01', '2025-05-31', flatSeasons(0.22)));
    expect(problems).toEqual([]);
  });

  it('fills only part of a gap, leaving a shorter gap after it', async () => {
    const siteId = await newSite();
    await manual(siteId, 'Early', '2024-01-01', '2024-12-31', flatSeasons(0.15));
    await manual(siteId, 'Late', '2025-09-01', null, flatSeasons(0.18));
    const { problems } = await audit(siteId, manualRequest('2025-02-01', '2025-03-31', flatSeasons(0.25)));
    expect(problems).toEqual([]);
  });

  it('backdates before the earliest plan', async () => {
    const siteId = await newSite();
    await manual(siteId, 'First', '2025-01-01', null, flatSeasons(0.16));
    const { problems } = await audit(siteId, manualRequest('2024-03-01', '2024-06-30', flatSeasons(0.21)));
    expect(problems).toEqual([]);
  });

  it('replaces an earliest plan that starts in the future', async () => {
    const siteId = await newSite();
    await manual(siteId, 'Next Year', '2026-12-01', null, flatSeasons(0.16));
    const { problems } = await audit(siteId, manualRequest('2026-12-01', null, flatSeasons(0.24)));
    expect(problems).toEqual([]);
  });

  it('sets an ongoing plan over everything', async () => {
    const siteId = await newSite();
    await manual(siteId, 'Early', '2024-01-01', '2024-12-31', touSeasons(0.3, 0.1));
    await manual(siteId, 'Late', '2025-06-01', null, flatSeasons(0.18));
    const { problems } = await audit(siteId, manualRequest('2023-06-01', null, flatSeasons(0.2)));
    expect(problems).toEqual([]);
  });

  it('replaces a Tesla plan with mid-month seasons and an overnight window', async () => {
    const siteId = await newSite();
    const window = (name: string, buy: number, from: number, to: number, days: [number, number] = [0, 6]) => ({
      name, buy_rate: buy, sell_rate: 0.03, from_day_of_week: days[0], to_day_of_week: days[1],
      from_hour: from, from_minute: 0, to_hour: to, to_minute: 0,
    });
    await tesla(siteId, {
      name: 'Tesla Overnight',
      seasons: [
        { name: 'Summer', from_month: 6, from_day: 15, to_month: 9, to_day: 14, buy_rate: 0.1, sell_rate: 0.03,
          schedules: [window('SUPER_OFF_PEAK', 0.06, 22, 6), window('ON_PEAK', 0.42, 16, 21, [0, 4]), window('OFF_PEAK', 0.13, 0, 24)] },
        { name: 'Winter', from_month: 9, from_day: 15, to_month: 6, to_day: 14, buy_rate: 0.1, sell_rate: 0.03,
          schedules: [window('SUPER_OFF_PEAK', 0.07, 22, 6), window('OFF_PEAK', 0.11, 0, 24)] },
      ],
    } as ParsedTariff, '2024-01-01', null);
    const { problems } = await audit(siteId, manualRequest('2025-01-01', '2025-12-31', touSeasons(0.38, 0.12)));
    expect(problems).toEqual([]);
  });

  it('replaces a Tesla plan with weekday-specific rules, and says so', async () => {
    const siteId = await newSite();
    // $0.10 Monday–Saturday, $0.50 Sunday.
    await tesla(siteId, teslaPlan('Sunday Peak', 0.1, 0.5, [0, 5]), '2024-01-01', null);
    const { preview, problems } = await audit(siteId, manualRequest('2025-01-01', null, flatSeasons(0.1)));
    expect(preview.approximationNotes.map(n => n.kind)).toContain('day_specific_schedule');
    expect(problems).toEqual([]);
  });

  it('restores Tesla plans where saved originals exist and leaves the rest', async () => {
    const siteId = await newSite();
    await tesla(siteId, teslaPlan('Tesla A', 0.12), '2024-01-01', '2025-05-31');
    await manual(siteId, 'June Manual', '2025-06-01', '2025-06-30', flatSeasons(0.3));
    await tesla(siteId, teslaPlan('Tesla B', 0.14), '2025-07-01', null);
    const override = await audit(siteId, manualRequest('2025-03-01', '2025-09-30', flatSeasons(0.2), 'Override'));
    expect(override.problems).toEqual([]);
    const { rows } = await local.database.query<{ id: number }>(
      `SELECT id FROM "TariffSelection" WHERE site_id = $1 AND candidate_kind = 'manual' ORDER BY id DESC LIMIT 1`, [siteId]
    );
    const restore = await audit(siteId, {
      scope: 'actual', candidate: { kind: 'restore_tesla', originalSelectionId: Number(rows[0].id) },
      effectiveFrom: '2025-03-01', effectiveTo: '2025-09-30',
    });
    expect(restore.preview.affectedIntervals.map(i => i.kind)).toContain('restore_unavailable');
    expect(restore.problems).toEqual([]);
  });

  const revisions = [flatRate('rev-a', '2024-01-01', 0.2), flatRate('rev-b', '2025-07-01', 0.23, 'rev-a')];

  it('sets a plan inside public-rate estimates, which then fill around it', async () => {
    const siteId = await estimatedSite(revisions, 'rev-b');
    const { problems } = await audit(siteId, manualRequest('2025-03-01', '2025-03-31', flatSeasons(0.27)));
    expect(problems).toEqual([]);
  });

  it('sets an ongoing plan over public-rate estimates', async () => {
    const siteId = await estimatedSite(revisions, 'rev-b');
    const { problems } = await audit(siteId, manualRequest('2026-01-01', null, touSeasons(0.35, 0.11)));
    expect(problems).toEqual([]);
  });

  it('replaces the earliest public-rate estimate', async () => {
    const siteId = await estimatedSite(revisions, 'rev-b');
    const { problems } = await audit(siteId, manualRequest('2024-01-01', '2024-06-30', flatSeasons(0.19)));
    expect(problems).toEqual([]);
  });

  it('changes the fixed comparison plan without touching billing', async () => {
    const siteId = await newSite();
    await manual(siteId, 'Base', '2024-01-01', null, flatSeasons(0.2));
    await repo.createReferencePeriod(siteId, 'u1', {
      name: 'Fixed', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: flatSeasons(0.15),
    });
    const { preview, problems } = await audit(siteId, {
      scope: 'reference', candidate: { kind: 'manual', name: 'Fixed 2', seasons: flatSeasons(0.17) },
      effectiveFrom: '2025-01-01', effectiveTo: null,
    });
    expect(preview.recalculatesHistory).toBe(false);
    expect(problems).toEqual([]);
  });
});
