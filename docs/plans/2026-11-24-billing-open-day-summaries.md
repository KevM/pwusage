# Billing Reads From Open-Day Summaries Implementation Plan

> Use the superpowers:executing-plans skill when implementing this plan.

**Goal** Bill reads that do not already hold today's samples price today from its stored summary
rows instead of decoding the day's sample payload. The results stay the same, with less egress and
CPU per read.

**Why** A bill read splits the cycle at site-local midnight. Earlier days come from
`EnergyDaySummary` (one row per tariff schedule per day). Today comes from the open
`EnergyDayArchive` payload, which the server decodes and re-totals by period
(`EnergyRepo.getUsageByTOU` and `getBillOutlook` in `cmd/next-app/src/lib/energy-repo.ts`). Every
import that changes a day already writes that day's summary rows, including the open day
(`replaceDay` in `lib/prototypes/compact-history-store.ts`). The scalar read only covers whole days
(`day_end <= end`), so today's rows are skipped even though they exist.

**Scope** In scope: `getUsageByTOU` when the caller passes no `todayRows`, and `getBillOutlook`.
Those serve the iOS bill summary, `site-service.ts`, and the planned integration billing API
([2026-11-23-integration-snapshots.md](2026-11-23-integration-snapshots.md)). Out of scope: the
live page and `site-live-data`. They read today's samples for charts anyway and already pass them
in, so they keep pricing from those samples.

**Stack** Next.js, Supabase Postgres and Vitest.

## 1. Pin today's results before changing them

**Files** `cmd/next-app/src/lib/energy-repo.test.ts` and the compact history reader and store tests
under `cmd/next-app/src/lib/prototypes/`.

1. Add failing tests that pin the current output for an in-progress day. Cover:
   - an on-peak/off-peak boundary crossed today
   - a tariff version change earlier in the cycle
   - a cycle that starts today
   - no import yet today
   - an `empty` day record
   - a legacy-format day, which must keep the detail path
2. Add a test that the store's scalar snapshot returns the open day's summary and coverage rows
   when the window runs to the open day's `day_end`. Confirm `verify_compact_day_range` accepts an
   open modern day. If it does not, the reader must fall back rather than throw.

## 2. Read today's summaries in the usage path

**Files** `cmd/next-app/src/lib/energy-repo.ts`, its test, and the reader tests.

1. When no `todayRows` are supplied, request cycle aggregates through today's site-local `day_end`.
   Stop splitting at midnight and reading raw samples. One scalar query then covers the whole cycle,
   including today.
2. Attribution fallback: the raw path prices today's samples from the live tariff timeline even
   when the open day's stored attribution is incomplete. The scalar path raises
   `IncompleteTariffAttributionError` instead. When attribution is incomplete only for the open day,
   fall back to the current raw read for today. Keep raising for incomplete earlier days, as today.
3. Pricing parity: summaries price by the stored `tariff_schedule_id`, while the raw path resolves
   each sample's period from the timeline. Assert that both produce identical `UsageData`
   (period name, rates, kWh) for the fixtures in step 1.
4. Run `npm test -- --run src/lib/energy-repo.test.ts src/lib/prototypes`.

## 3. Feed the bill outlook from coverage stats

**Files** `cmd/next-app/src/lib/energy-repo.ts` (`getBillOutlook`, `buildBillOutlook`) and their tests.

1. `buildBillOutlook` uses today's samples only for the sample count and the day's totals. Take the
   count, first and last timestamps, and the largest gap for today from the scalar coverage stats,
   the same way earlier days already work. Take `lastTimestampMs` from coverage.
2. Today's expected slot count still runs only up to now, so an in-progress day stays incomplete.
3. Verify the iOS bill-summary contract is unchanged with
   `npm test -- --run src/app/api/mobile/bill-summary/route.test.ts`, including revision and ETag
   values for an unchanged day.

## 4. Measure and verify

1. Measure database bytes and latency for one bill-summary read on a positively identified Dev
   database, before and after the change. Count bytes on the socket, as the cron egress work does.
   Record the numbers in the PR description.
2. Run a read-only parity check on the Dev database across every site with a current cycle. Compare
   the old and new `getUsageByTOU` and `getBillOutlook` output, and report any mismatch by site and
   period. The check must make no Tesla requests.
3. Run `npm run lint`, `npm run typecheck`, `npm test -- --run` and `npm run build` from
   `cmd/next-app`, in that order.

## References

- [Web app guide](../../cmd/next-app/AGENTS.md)
- [Integration billing API plan](2026-11-23-integration-snapshots.md)
- [Current-day storage and recovery behavior](2026-10-24-day-record-v2.md)
- [Historical tariff attribution](../../DesignDecisions.md)
- [Dev database safeguards](../dev-database-copy.md)
