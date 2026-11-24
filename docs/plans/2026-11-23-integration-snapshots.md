# PWUsage Integration Billing API Implementation Plan

> Use the superpowers:executing-plans skill when implementing this plan.

**Goal** Let a homelab worker read its site's current billing state while the PWUsage iOS app is closed.

**Architecture** The integration API and the iOS bill-summary route call the same server-side billing service over existing energy history. Each route authenticates its own caller. A 15-minute job refreshes Tesla history for opted-in sites. The billing API has no queue or separate snapshot store.

**Stack** Next.js, Supabase Postgres, the existing `pg_cron` and `pg_net` scheduling pattern, and Vitest.

## 1. Share the current billing calculation

**Files** Create `cmd/next-app/src/lib/current-billing-service.ts` and its test. Update `cmd/next-app/src/app/api/mobile/bill-summary/route.ts` and its test. Reuse `mobile-bill-summary.ts`, `billing-availability.ts`, `energy-repo.ts`, and the tariff schedule helpers under `cmd/next-app/src/lib/`.

1. Add tests for the current cycle, historical tariff versions, incomplete billing coverage, and the source energy timestamp.
2. Move the current-cycle read behind a server-side service that accepts an already-authorized site and a clock value. Reuse the existing usage and pricing calculations. Preserve the mobile response shape, session authorization, outlook, and revision handling. The integration route can request the current cycle without the outlook or chart data.
3. Verify parity with `npm test -- --run src/lib/current-billing-service.test.ts src/app/api/mobile/bill-summary/route.test.ts`. Include a midnight and billing-cycle rollover check. Use the current time to resolve tariff boundaries and the energy timestamp for data freshness.

## 2. Expose a read-only billing endpoint

**Files** Create `cmd/next-app/src/app/api/integrations/v1/billing/route.ts` and its test, and `cmd/next-app/src/lib/integration-token-repo.ts`. Add an operator provisioning command under `cmd/next-app/scripts/` for the pilot. Record the authentication contract in `Authentication.md`.

1. Generate a private credential table migration with `npm run db:migration:create integration_billing_access` from `cmd/next-app`. Use the app's RLS and explicit grants. Bind each credential to one site and the billing-read scope.
2. Generate one high-entropy bearer token per installation and store only its hash. Support creating, rotating, and revoking the pilot credential. Accept the token in the `Authorization` header. Resolve the site from the credential. Keep tokens out of URLs and logs and prevent shared caching of responses.
3. Return a versioned response with billing availability, currency, cycle bounds, time zone, observed energy timestamp, and the bank or deficit for each relevant tariff period. Positive `bankKwh` means banked energy. Identify the currently active period with its applicable buy and sell rates and end time when resolvable. Use the existing tariff timeline logic to establish boundaries and preserve null or incomplete states.
4. Verify with `npm test -- --run src/app/api/integrations/v1/billing/route.test.ts`. Cover invalid and revoked tokens, cross-site isolation, parity with iOS billing, and a period change without fresh telemetry. Confirm that the API calls neither the importer nor Tesla.

## 3. Refresh opted-in sites every 15 minutes

**Files** Create `cmd/next-app/src/app/api/cron/refresh-integration-sites/route.ts` and its test. Reuse `cmd/next-app/src/lib/today-refresh.ts` and `importer/index.ts`. Generate the schedule migration with the repo generator.

1. Enroll one site for the pilot. Tie eligibility to an active billing integration so revoking the last credential also stops this scheduled refresh. A TRMNL installation alone does not enroll a site.
2. Follow the existing authenticated `pg_cron` route pattern. Use bounded concurrency, the existing sample-due check, and the cross-instance import claim. Request energy and SOC history through the current importer. Keep historical gap recovery active.
3. Verify with `npm test -- --run src/app/api/cron/refresh-integration-sites/route.test.ts`. Cover opted-out sites, overlapping calls, not-yet-due samples, and failed or delayed imports. Confirm reads continue reporting the original source timestamp when no new data arrives.

## 4. Verify the pilot

1. Run `npm run lint`, `npm run typecheck`, `npm test -- --run`, and `npm run build` from `cmd/next-app`, in that order. Apply migrations locally and verify against a positively identified Dev database before the production pilot.
2. Poll from the homelab across an On-Peak boundary in observation mode. Check that the worker can distinguish a bank from a deficit, declines to enable Aux on stale or unavailable data, and can restore its prior mode using the last known On-Peak end time. The homelab owns the temperature threshold, bank thresholds, and ecobee credentials.
3. Measure the database bytes and latency for a representative day of polling, along with the Tesla request count and source-data age. If repeated bill calculations become a meaningful cost, use those measurements to decide whether to add caching. Evaluate any TRMNL refactor separately against its display and chart needs.

## References

- [Web app guide](../../cmd/next-app/AGENTS.md)
- [Current iOS bill-summary route](../../cmd/next-app/src/app/api/mobile/bill-summary/route.ts)
- [Tesla import claims and historical tariff attribution](../../DesignDecisions.md)
- [Application and TRMNL authentication](../../Authentication.md)
- [Current-day storage and recovery behavior](2026-10-24-day-record-v2.md)
- [Dev database safeguards](../dev-database-copy.md)
