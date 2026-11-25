import { z } from 'zod';

/**
 * The MCP tools' output contract. Each tool declares one of these as its
 * `outputSchema`; the SDK validates `structuredContent` against it before
 * replying and publishes it to clients (as JSON Schema with
 * `additionalProperties: false`), so every field a tool returns must be here.
 * Handlers type their payloads from these schemas, so a drift fails at compile time.
 */

const siteId = z.string().describe('Home siteId, from list_homes.');
const iana = z.string().describe('IANA timezone of the home; all dates and phrases are local to it.');
const isoTime = z.string().describe('ISO 8601 UTC timestamp.');
const watts = z.number().nonnegative().nullable();
const rate = z.number().describe('Price per kWh in the bill currency.');

const setupNotice = z.object({
    missingTariff: z.boolean(),
    missingBillingStartDay: z.boolean(),
    message: z.string(),
    settingsUrl: z.string().describe('Where the owner finishes setup in PWUsage.'),
}).describe('Present only when the rate plan or billing start day is not set up; costs are unreliable until it is.');

const loadTimingPeriod = z.object({
    name: z.string().describe('Rate period name, e.g. ON_PEAK.'),
    marginalCost: z.number().nullable().describe('What one more kWh used in this period costs: the sell rate while the cycle has an export cushion here, otherwise the buy rate.'),
    basis: z.enum(['sell', 'buy', 'neutral']).describe('Which rate marginalCost is based on.'),
    cycleNetExportKwh: z.number().describe('Export cushion: net kWh exported in this period so far this cycle (negative = net import).'),
    isActive: z.boolean().describe('True for the rate period in effect now.'),
    nextStartPhrase: z.string().nullable().describe('When this period next starts, in local words (null while active).'),
    buyRate: rate,
    sellRate: rate,
});

const rateSegment = z.object({
    start: isoTime,
    end: isoTime,
    periodKey: z.string(),
    name: z.string().describe('Rate period name.'),
    buyRate: rate,
    sellRate: rate,
});

const loadTimingFields = {
    hasTariff: z.boolean(),
    hasCycleData: z.boolean(),
    activeIsCheapest: z.boolean().describe('True when now is the cheapest time this cycle to run a job.'),
    periods: z.array(loadTimingPeriod).describe('Rate periods this cycle has recorded.'),
    pricingPeriods: z.array(loadTimingPeriod).describe('Every rate period of the current season, including ones not reached yet this cycle.'),
    nextCheaper: z.object({ name: z.string(), marginalCost: z.number(), phrase: z.string() }).nullable()
        .describe('The next period cheaper than now, if any.'),
    nextCheaperPhrase: z.string().nullable(),
    nextStartPhraseByKey: z.record(z.string(), z.string()).describe('Next start of each rate period, in local words.'),
};

export const listHomesOutput = z.object({
    homes: z.array(z.object({
        siteId,
        name: z.string(),
        utility: z.string().nullable(),
        timezone: iana,
        billingStartDay: z.number().int().min(1).max(31).describe('Day of month the billing cycle starts.'),
        setupStatus: z.object({ hasTariff: z.boolean(), billingDayConfirmed: z.boolean() }),
    })),
});

export const liveStatusOutput = z.object({
    siteId,
    statusSource: z.enum(['refreshed', 'cached', 'connection-required', 'error'])
        .describe('refreshed: fetched from Tesla now. cached: a recent stored reading. connection-required: the stored reading, but the Tesla connection needs reconnecting. error: the stored reading after a failed refresh.'),
    fetchedAt: isoTime.nullable().describe('When Tesla reported this reading.'),
    solarPowerW: watts.describe('Solar generation, watts.'),
    loadPowerW: watts.describe('Home use, watts.'),
    gridImportW: watts.describe('Power drawn from the grid, watts (0 while exporting).'),
    gridExportW: watts.describe('Power sent to the grid, watts (0 while importing).'),
    batteryChargingW: watts.describe('Power going into the Powerwall, watts (0 while discharging).'),
    batteryDischargingW: watts.describe('Power coming out of the Powerwall, watts (0 while charging).'),
    batterySocPercent: z.number().nullable().describe('Powerwall state of charge, percent.'),
    gridStatus: z.string().nullable().describe('Tesla grid status, e.g. Active, or Inactive during an outage.'),
    stormModeActive: z.boolean().nullable().describe('True while Storm Watch is holding the Powerwall full.'),
});

export const currentBillOutput = z.object({
    siteId,
    siteName: z.string(),
    timezone: iana,
    currentBill: z.object({
        status: z.enum(['complete', 'incomplete-attribution']).optional()
            .describe('incomplete-attribution: some days are not yet priced against the rate plan, so the cost is low.'),
        estimatedCost: z.number().nullable().describe('Energy cost so far this cycle, in currency; null when unavailable.'),
        currency: z.string(),
        cycleStart: isoTime,
        cycleEnd: isoTime.describe('Exclusive end of the cycle.'),
        periods: z.array(z.object({
            tariffName: z.string(),
            periodName: z.string(),
            netGridKwh: z.number().describe('Net kWh from the grid in this period this cycle (negative = net export).'),
            cost: z.number().describe('Cost in this period (negative = credit).'),
        })),
    }),
    loadTiming: z.object(loadTimingFields).nullable().describe('Smart Shift view of the cycle by rate period.'),
    energyDataThrough: isoTime.nullable().describe('Latest energy data the bill includes.'),
    setupNotice: setupNotice.optional(),
});

export const smartShiftOutlookOutput = z.object({
    siteId,
    siteName: z.string(),
    timezone: iana,
    loadTiming: z.object({
        ...loadTimingFields,
        tariffTimeline: z.array(rateSegment).describe('Rate periods from the latest data to the end of the cycle.'),
    }).nullable(),
    upcomingRateTimeline: z.array(rateSegment.extend({ tariffName: z.string(), periodName: z.string() }))
        .describe('Rate periods from now to the end of the cycle, with the rate plan name.'),
    energyDataThrough: isoTime.nullable(),
    setupNotice: setupNotice.optional(),
});

const kwh = z.number().nullable();

export const dailyUsageOutput = z.object({
    siteId,
    fromDate: z.string().describe('YYYY-MM-DD, local to the home.'),
    toDate: z.string().describe('YYYY-MM-DD, local to the home.'),
    syncInProgress: z.boolean().describe('True when no day in the range has been imported yet.'),
    days: z.array(z.object({
        date: z.string().describe('YYYY-MM-DD, local to the home.'),
        status: z.enum(['complete', 'partial', 'gapped', 'no_data', 'missing'])
            .describe('complete: all 5-minute samples. partial: still filling in (today, or a recent day awaiting gap healing). gapped: ended short; totals undercount. no_data: Tesla returned no samples. missing: not imported.'),
        sampleCount: z.number().int().nonnegative(),
        expectedSamples: z.number().int().positive().nullable().describe('5-minute samples in a full day (276 or 300 on DST change days); null when missing.'),
        loadKwh: kwh.describe('Home use, kWh; null when the day has no samples.'),
        solarKwh: kwh,
        gridImportKwh: kwh,
        gridExportKwh: kwh,
        batteryChargeKwh: kwh,
        batteryDischargeKwh: kwh,
    })).describe('Every date from fromDate up to the earlier of toDate and today.'),
});

export type ListHomesOutput = z.infer<typeof listHomesOutput>;
export type LiveStatusOutput = z.infer<typeof liveStatusOutput>;
export type CurrentBillOutput = z.infer<typeof currentBillOutput>;
export type SmartShiftOutlookOutput = z.infer<typeof smartShiftOutlookOutput>;
export type DailyUsageOutput = z.infer<typeof dailyUsageOutput>;
