import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import fixtureJson from './__fixtures__/tesla-tariff-two-season.json';
import type { SiteTariffsTimelineResponse, TariffSeasonInput, TimePeriodWindowInput } from './tariff-contract';
import type { EnergySiteInfo, TariffV2, TeslaClient } from './tesla-client';
import { TeslaAuthError } from './tesla-client';
import { TeslaConnectionRequiredError } from './tesla-refresh-outcome';
import { ioSignal, withIoDeadline } from './io-deadline';
import { buildTeslaTariff, applyTeslaAdjustments } from './tesla-tou-sync';
import {
  commitTeslaSync,
  previewTeslaSync,
  TeslaSyncUnavailableError,
  type TeslaTariffSyncDeps,
} from './tesla-tariff-sync-service';
import type { ActiveActualPlan, SiteUtilityContextResult, TariffTimelineRepo } from './tariff-timeline-repo';
import type { TeslaTariffSyncRepo } from './tesla-tariff-sync-repo';

const BASE = fixtureJson as unknown as TariffV2;

function win(
  touName: TimePeriodWindowInput['touName'],
  fromHour: number,
  toHour: number,
  buyRate: number,
  sellRate: number,
): TimePeriodWindowInput {
  return { touName, fromHour, fromMinute: 0, toHour, toMinute: 0, buyRate, sellRate };
}

/** Full-year valid plan: Summer Jun-Sep with a weekday peak, Winter Oct-May flat. */
function plan(summerPeakBuy = 0.4, summerPeakSell = 0.05): TariffSeasonInput[] {
  return [
    {
      name: 'Summer',
      fromMonth: 6,
      fromDay: 1,
      toMonth: 9,
      toDay: 30,
      weekdayPeriods: [
        win('OFF_PEAK', 0, 16, 0.1, 0.03),
        win('ON_PEAK', 16, 21, summerPeakBuy, summerPeakSell),
        win('OFF_PEAK', 21, 24, 0.1, 0.03),
      ],
      weekendPeriods: [win('OFF_PEAK', 0, 24, 0.1, 0.03)],
    },
    {
      name: 'Winter',
      fromMonth: 10,
      fromDay: 1,
      toMonth: 5,
      toDay: 31,
      weekdayPeriods: [win('OFF_PEAK', 0, 24, 0.12, 0.03)],
      weekendPeriods: [win('OFF_PEAK', 0, 24, 0.12, 0.03)],
    },
  ];
}

/** Tesla's stored content once it has taken `seasons` under `name`. */
function teslaContent(seasons: TariffSeasonInput[], name = 'Tesla Current'): TariffV2 {
  return buildTeslaTariff(BASE, { name, seasons });
}

function infoFor(content: TariffV2 | null, touCapable = true): EnergySiteInfo {
  return {
    id: 'tesla-1',
    components: { tou_capable: touCapable },
    tariff_content_v2: content,
    site_name: 'Home',
  } as unknown as EnergySiteInfo;
}

const TIMELINE = { siteId: 's1' } as unknown as SiteTariffsTimelineResponse;

function activePlan(overrides: Partial<ActiveActualPlan> = {}): ActiveActualPlan {
  return {
    tariffId: 5,
    selectionId: 9,
    source: 'manual',
    name: 'My Plan',
    seasons: plan(),
    daySpecific: false,
    ...overrides,
  };
}

/**
 * Fakes for the sync service. `state.content` is what Tesla stores; a write replaces it with
 * `storeOnWrite(payload)`, so a read-back matches whatever Tesla would keep.
 */
function harness(options: {
  active?: ActiveActualPlan | null;
  teslaContent?: TariffV2 | null;
  touCapable?: boolean;
  storeOnWrite?: (payload: TariffV2) => TariffV2;
  writeError?: unknown;
  /** Tesla stores the plan, then the call fails: the write reached Tesla but the answer was lost. */
  storeBeforeError?: boolean;
  readAfterWriteError?: unknown;
  clientNull?: boolean;
  inFlight?: boolean;
} = {}) {
  const state = { content: options.teslaContent === undefined ? teslaContent(plan(0.3, 0.05), 'Tesla Current') : options.teslaContent };
  const events: string[] = [];
  let written = false;

  const client = {
    getEnergySiteInfo: vi.fn(async (): Promise<EnergySiteInfo> => {
      if (written && options.readAfterWriteError) throw options.readAfterWriteError;
      events.push('read');
      return infoFor(state.content, options.touCapable ?? true);
    }),
    setTimeOfUseSettings: vi.fn(async (_siteId: string, payload: TariffV2) => {
      events.push('write');
      if (options.writeError && !options.storeBeforeError) throw options.writeError;
      written = true;
      state.content = options.storeOnWrite ? options.storeOnWrite(payload) : payload;
      if (options.writeError) throw options.writeError;
      return { result: true, message: null } as never;
    }),
  };

  const tx = {
    query: vi.fn(async (sql: string) => {
      events.push(sql.trim().split(/\s+/)[0]);
      if (sql.includes('FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };

  const repo = {
    getSiteUtilityContext: vi.fn(async (): Promise<SiteUtilityContextResult> => ({
      name: 'Utility',
      timezone: 'America/Chicago',
      currency: 'USD',
      choice: 'owner',
    })),
    getTimeline: vi.fn(async () => TIMELINE),
    loadActiveActualPlan: vi.fn(async () => (options.active === undefined ? activePlan() : options.active)),
  };

  const syncRepo = {
    beginAttempt: vi.fn(async () => (options.inFlight
      ? { inFlight: { id: 7, status: 'sending' } as never }
      : { id: 42 })),
    finishAttempt: vi.fn(async () => true),
  };

  const importSite = vi.fn(async () => {});
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

  const deps: TeslaTariffSyncDeps = {
    clientFor: vi.fn(async () => (options.clientNull ? null : (client as unknown as TeslaClient))),
    repo: repo as unknown as Pick<TariffTimelineRepo, 'getSiteUtilityContext' | 'getTimeline' | 'loadActiveActualPlan'>,
    syncRepo: syncRepo as unknown as Pick<TeslaTariffSyncRepo, 'beginAttempt' | 'finishAttempt'>,
    connect: vi.fn(async () => tx as unknown as PoolClient),
    importSite,
    now: () => new Date('2026-11-19T18:00:00Z'),
    sleep,
  };

  return { deps, state, client, tx, repo, syncRepo, importSite, sleep, events };
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TeslaSyncUnavailableError) return error.reason;
    throw error;
  }
  throw new Error('expected the preview to throw');
}

describe('previewTeslaSync', () => {
  it('returns current, proposed, adjustments and estimated for a public plan', async () => {
    const publicSeasons = plan(0.04, 0.05); // ON_PEAK buy below export: Tesla raises it
    const h = harness({
      active: activePlan({ source: 'estimated', name: 'Public Plan', seasons: publicSeasons, selectionId: null }),
      teslaContent: teslaContent(plan(), 'Tesla Current'),
    });

    const preview = await previewTeslaSync('s1', 'u1', h.deps);

    expect(preview.current.name).toBe('Tesla Current');
    expect(preview.current.seasons.length).toBe(2);
    expect(preview.proposed).toMatchObject({ name: 'Public Plan', source: 'estimated', selectionId: null });
    expect(preview.estimated).toBe(true);
    expect(preview.adjustments).toEqual(applyTeslaAdjustments(publicSeasons).adjustments);
    expect(preview.adjustments[0]).toMatchObject({ season: 'Summer', period: 'ON_PEAK', side: 'buy', reason: 'raised_to_sell' });
    expect(preview.problems).toEqual([]);
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks a manual plan as not estimated', async () => {
    const h = harness({ teslaContent: teslaContent(plan(0.3, 0.05)) });
    const preview = await previewTeslaSync('s1', 'u1', h.deps);
    expect(preview.estimated).toBe(false);
    expect(preview.proposed.source).toBe('manual');
  });

  it('returns problems without throwing when the plan cannot be sent as is', async () => {
    const gapped = [plan()[0]]; // Summer only: Oct-May uncovered
    const h = harness({ active: activePlan({ seasons: gapped }) });
    const preview = await previewTeslaSync('s1', 'u1', h.deps);
    expect(preview.problems.map(p => p.code)).toContain('season_gap');
  });

  it('lists day_specific_schedule when the plan has rules for specific weekdays', async () => {
    const h = harness({ active: activePlan({ daySpecific: true }), teslaContent: teslaContent(plan()) });
    const preview = await previewTeslaSync('s1', 'u1', h.deps);
    expect(preview.problems.map(p => p.code)).toContain('day_specific_schedule');
    expect(preview.problems.find(p => p.code === 'day_specific_schedule')?.message).toMatch(/specific weekdays/);
  });

  it('does not report no_difference when Tesla holds a Friday-only window on the same Monday and Saturday shape', async () => {
    const content = teslaContent(plan());
    content.seasons.Summer.tou_periods.ON_PEAK.periods.push({
      fromDayOfWeek: 4, toDayOfWeek: 4, fromHour: 6, fromMinute: 0, toHour: 8, toMinute: 0,
    });
    const h = harness({ teslaContent: content });
    const preview = await previewTeslaSync('s1', 'u1', h.deps);
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws no_difference when Tesla already stores the plan', async () => {
    const h = harness({ teslaContent: teslaContent(plan()) });
    expect(await reasonOf(previewTeslaSync('s1', 'u1', h.deps))).toBe('no_difference');
  });

  it('throws not_tou_capable when the Powerwall cannot take time-of-use rates', async () => {
    const h = harness({ touCapable: false });
    expect(await reasonOf(previewTeslaSync('s1', 'u1', h.deps))).toBe('not_tou_capable');
  });

  it('throws no_tesla_plan when Tesla holds no tariff', async () => {
    const h = harness({ teslaContent: null });
    expect(await reasonOf(previewTeslaSync('s1', 'u1', h.deps))).toBe('no_tesla_plan');
  });

  it('throws no_active_plan when no actual plan covers today', async () => {
    const h = harness({ active: null });
    expect(await reasonOf(previewTeslaSync('s1', 'u1', h.deps))).toBe('no_active_plan');
  });

  it('throws needs_reauth when the member has no Tesla client', async () => {
    const h = harness({ clientNull: true });
    expect(await reasonOf(previewTeslaSync('s1', 'u1', h.deps))).toBe('needs_reauth');
  });

  it('throws needs_reauth when Tesla rejects the member\'s credentials on the read', async () => {
    const h = harness();
    h.client.getEnergySiteInfo.mockRejectedValue(new TeslaAuthError('Tesla API Error: 401 expired', 401));
    expect(await reasonOf(previewTeslaSync('s1', 'u1', h.deps))).toBe('needs_reauth');
  });

  it('throws needs_reauth when the Tesla connection must be re-made', async () => {
    const h = harness();
    h.client.getEnergySiteInfo.mockRejectedValue(new TeslaConnectionRequiredError());
    expect(await reasonOf(previewTeslaSync('s1', 'u1', h.deps))).toBe('needs_reauth');
  });

  it('throws not_allowed when Tesla answers 403 on the read', async () => {
    const h = harness();
    h.client.getEnergySiteInfo.mockRejectedValue(new TeslaAuthError('Tesla API Error: 403 forbidden', 403));
    expect(await reasonOf(previewTeslaSync('s1', 'u1', h.deps))).toBe('not_allowed');
  });

  it('reads Tesla with the pressing member\'s client', async () => {
    const h = harness();
    await previewTeslaSync('s1', 'member-user', h.deps);
    expect(h.deps.clientFor).toHaveBeenCalledWith('s1', 'member-user');
  });
});

describe('commitTeslaSync', () => {
  async function previewFingerprint(h: ReturnType<typeof harness>): Promise<string> {
    return (await previewTeslaSync('s1', 'u1', h.deps)).fingerprint;
  }

  it('returns needs_reauth without a Tesla client and writes nothing', async () => {
    const h = harness({ clientNull: true });
    const result = await commitTeslaSync('s1', 'u1', 'fp', h.deps);
    expect(result.outcome).toBe('needs_reauth');
    expect(h.client.setTimeOfUseSettings).not.toHaveBeenCalled();
  });

  it('returns unavailable and never writes when the plan is day-specific', async () => {
    const h = harness({ active: activePlan({ daySpecific: true }), teslaContent: teslaContent(plan()) });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('unavailable');
    expect(result.message).toMatch(/specific weekdays/);
    expect(h.client.setTimeOfUseSettings).not.toHaveBeenCalled();
    expect(h.syncRepo.beginAttempt).not.toHaveBeenCalled();
  });

  it('returns conflict and never writes when Tesla changed after the preview', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);
    h.state.content = teslaContent(plan(0.3, 0.05), 'Edited In App');

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('conflict');
    expect(h.client.setTimeOfUseSettings).not.toHaveBeenCalled();
    expect(h.syncRepo.beginAttempt).not.toHaveBeenCalled();
  });

  it('returns unavailable with the problems and never writes', async () => {
    const h = harness({ active: activePlan({ seasons: [plan()[0]] }) });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('unavailable');
    expect(result.message).toMatch(/No season covers/);
    expect(h.client.setTimeOfUseSettings).not.toHaveBeenCalled();
  });

  it('returns in_flight while another attempt is sending and never writes', async () => {
    const h = harness({ inFlight: true });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('in_flight');
    expect(h.client.setTimeOfUseSettings).not.toHaveBeenCalled();
  });

  it('writes after the lock transaction commits, never while it is open', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);
    h.events.length = 0;

    await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    const beginAt = h.events.indexOf('BEGIN');
    const commitAt = h.events.indexOf('COMMIT');
    const writeAt = h.events.indexOf('write');
    expect(beginAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(beginAt);
    expect(writeAt).toBeGreaterThan(commitAt);
    expect(h.events.slice(beginAt, commitAt)).not.toContain('write');
  });

  it('confirms when the read-back matches, then imports the read-back plan', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result).toEqual({ outcome: 'confirmed', message: 'Tesla now has this plan.', timeline: TIMELINE });
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'confirmed', expect.anything());
    expect(h.importSite).toHaveBeenCalledWith(expect.anything(), 's1');
  });

  it('confirms when Tesla stored the adjusted rates', async () => {
    const h = harness({
      active: activePlan({ source: 'estimated', seasons: plan(0.04, 0.05), selectionId: null }),
      storeOnWrite: () => teslaContent(applyTeslaAdjustments(plan(0.04, 0.05)).seasons, 'PWUsage Plan'),
    });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('confirmed');
  });

  it('returns unconfirmed after five reads over 20 s when Tesla keeps another plan', async () => {
    const h = harness({ storeOnWrite: () => teslaContent(plan(0.3, 0.05), 'Old') });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result).toEqual({ outcome: 'unconfirmed', message: "Sent to Tesla. It hasn't confirmed yet; PWUsage will check again.", timeline: TIMELINE });
    expect(h.sleep).toHaveBeenCalledTimes(5);
    expect(h.sleep.mock.calls.every(([ms]) => ms === 4000)).toBe(true);
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'unconfirmed', expect.anything());
    expect(h.importSite).not.toHaveBeenCalled();
  });

  it('stops read-back by the clock when every read takes 8 s', async () => {
    const h = harness({ storeOnWrite: () => teslaContent(plan(0.3, 0.05), 'Old') });
    const fingerprint = await previewFingerprint(h);
    let clock = Date.parse('2026-11-19T18:00:00Z');
    const start = clock;
    h.deps.now = () => new Date(clock);
    h.deps.sleep = async ms => { clock += ms; };
    h.client.getEnergySiteInfo.mockImplementation(async () => {
      clock += 8000;
      return infoFor(h.state.content);
    });

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('unconfirmed');
    const elapsed = clock - start;
    // Two pre-write reads (16 s) plus a read-back that stops 20-25 s after the write.
    expect(elapsed).toBeLessThanOrEqual(16000 + 25000);
    expect(h.client.getEnergySiteInfo.mock.calls.length).toBeLessThan(2 + 5);
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'unconfirmed', expect.anything());
  });

  it('skips the import when little of the time budget is left after a confirmed write', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);
    let clock = Date.parse('2026-11-19T18:00:00Z');
    h.deps.now = () => new Date(clock);
    h.deps.sleep = async ms => { clock += ms; };
    h.client.getEnergySiteInfo.mockImplementation(async () => {
      clock += 20000;
      return infoFor(h.state.content);
    });

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('confirmed');
    expect(h.importSite).not.toHaveBeenCalled();
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'confirmed', expect.anything());
  });

  it('records unconfirmed outside the request deadline when it aborts after the write', async () => {
    const h = harness({ storeOnWrite: () => teslaContent(plan(0.3, 0.05), 'Old') });
    const fingerprint = await previewFingerprint(h);
    let abortedWhenRecording: boolean | undefined;
    h.syncRepo.finishAttempt.mockImplementation(async () => {
      abortedWhenRecording = ioSignal()?.aborted;
      return true;
    });
    // The first wait outlasts the 20 ms request deadline, as a slow Tesla would.
    h.deps.sleep = async () => {
      const signal = ioSignal();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };

    await expect(withIoDeadline(20, () => commitTeslaSync('s1', 'u1', fingerprint, h.deps))).rejects.toThrow();

    expect(h.client.setTimeOfUseSettings).toHaveBeenCalledTimes(1);
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'unconfirmed', expect.anything());
    expect(abortedWhenRecording).toBe(false);
  });

  it('leaves no message for a rejection whose body says nothing', async () => {
    const h = harness({ writeError: new Error('Tesla API Error: 400 ') });
    const fingerprint = await previewFingerprint(h);
    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);
    expect(result.outcome).toBe('rejected');
    expect(result.message).toBeUndefined();
  });

  it('counts a failed read during polling as not matching', async () => {
    const h = harness({ readAfterWriteError: new Error('Tesla API Error: 503 busy') });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('unconfirmed');
    expect(h.sleep).toHaveBeenCalledTimes(5);
  });

  it('maps a Tesla 403 to not_allowed', async () => {
    const h = harness({ writeError: new TeslaAuthError('Tesla API Error: 403 forbidden', 403) });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('not_allowed');
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'not_allowed', expect.anything());
  });

  it('maps a Tesla 401 to needs_reauth and stores the attempt as failed', async () => {
    const h = harness({ writeError: new TeslaAuthError('Tesla API Error: 401 expired', 401) });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('needs_reauth');
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'failed', expect.anything());
  });

  it('shows Tesla\'s plain-text message for a 400 with a JSON body', async () => {
    const h = harness({ writeError: new Error('Tesla API Error: 400 {"error":"Rates are out of range"}') });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result).toMatchObject({ outcome: 'rejected', message: 'Rates are out of range' });
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'rejected', expect.anything());
  });

  it('never shows raw JSON from a truncated 400 body', async () => {
    const h = harness({ writeError: new Error('Tesla API Error: 400 {"error":"Rates are out') });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('rejected');
    expect(result.message ?? '').not.toMatch(/[{}]/);
  });

  it('reads back after an ambiguous write failure and confirms when Tesla stored the plan', async () => {
    const h = harness({ writeError: new Error('socket hang up'), storeBeforeError: true });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result).toEqual({ outcome: 'confirmed', message: 'Tesla now has this plan.', timeline: TIMELINE });
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'confirmed', undefined);
    expect(h.importSite).toHaveBeenCalledWith(expect.anything(), 's1');
  });

  it('reads back after an ambiguous write failure and records unconfirmed when Tesla kept the old plan', async () => {
    const h = harness({ writeError: new Error('socket hang up') });
    const fingerprint = await previewFingerprint(h);

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('unconfirmed');
    expect(h.sleep).toHaveBeenCalledTimes(5);
    expect(h.syncRepo.finishAttempt).toHaveBeenCalledWith(42, 'unconfirmed', undefined);
    expect(h.syncRepo.finishAttempt).not.toHaveBeenCalledWith(42, 'failed', expect.anything());
  });

  it('rethrows an unclassified error raised before the write, so the route answers 500', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);
    h.repo.loadActiveActualPlan.mockRejectedValueOnce(new Error('db down'));

    await expect(commitTeslaSync('s1', 'u1', fingerprint, h.deps)).rejects.toThrow('db down');
    expect(h.client.setTimeOfUseSettings).not.toHaveBeenCalled();
  });

  it('reports Tesla unavailable, with nothing changed, when the read before the write fails', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);
    h.client.getEnergySiteInfo.mockRejectedValueOnce(new Error('socket hang up'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('failed');
    expect(result.message).toBe('Tesla is unavailable right now. Nothing changed on the Powerwall.');
    expect(h.client.setTimeOfUseSettings).not.toHaveBeenCalled();
    expect(h.syncRepo.beginAttempt).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('reports Tesla unavailable for a 5xx from the read before the write', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);
    h.client.getEnergySiteInfo.mockRejectedValueOnce(new Error('Tesla API Error: 503 busy'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('failed');
    expect(h.client.setTimeOfUseSettings).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('still maps an auth failure from the read before the write to needs_reauth', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);
    h.client.getEnergySiteInfo.mockRejectedValueOnce(new TeslaAuthError('Tesla API Error: 401 expired', 401));

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('needs_reauth');
  });

  it('throws tesla_unavailable from preview when the Tesla read fails with a server error', async () => {
    const h = harness();
    h.client.getEnergySiteInfo.mockRejectedValueOnce(new Error('Tesla API Error: 500 oops'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await reasonOf(previewTeslaSync('s1', 'u1', h.deps))).toBe('tesla_unavailable');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('still returns confirmed when recording the outcome fails after a real write', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);
    h.syncRepo.finishAttempt.mockRejectedValueOnce(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('confirmed');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('still returns the outcome when the timeline fetch fails after a write', async () => {
    const h = harness();
    const fingerprint = await previewFingerprint(h);
    h.repo.getTimeline.mockRejectedValueOnce(new Error('timeline down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await commitTeslaSync('s1', 'u1', fingerprint, h.deps);

    expect(result.outcome).toBe('confirmed');
    expect(result.timeline).toBeUndefined();
    error.mockRestore();
  });
});
