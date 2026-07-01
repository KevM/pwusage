# TODO

Cross-session work that didn't fit the current focus. Pull from this list when picking up new work.

## How to use this list

When starting fresh work in this repo, check this file. If a session begins something here, leave a short note (date + branch/PR) under the item so the next session knows it's in flight. Once landed, delete the item.

## TRMNL integration: architecture follow-ups

From the 2026-07-01 TRMNL review. Do these after the TRMNL security/caching fixes (commit `1d85639`) land. Each item is independent; run `npm run lint`, `npm test`, and `npm run build` in `cmd/next-app` after each.

### 1. Unify TRMNL request auth into one helper

Three routes implement "verify caller against stored access_token, else verify TRMNL JWT" with slightly different logic:

- `src/app/api/trmnl/markup/route.ts` GET (bearer check after installation lookup)
- `src/app/api/trmnl/uninstall/route.ts` (same pattern, duplicated)
- `src/app/api/trmnl/webhook/route.ts` (JWT branch, plus an opaque-token branch that matches against existing/pending/loose-pending installations)

Add a single helper in `src/lib/trmnl-auth.ts` (e.g. `verifyTrmnlRequestAuth(token, uuid, installation)`) that tries `safeTimingSafeEqual` against the stored token first, then falls back to `verifyTrmnlToken`, and use it in all three routes. While there: the webhook's opaque-token branch fetches the installation for auth, then the main flow fetches the same row again via `getInstallationByUuid` — pass the already-fetched installation through instead of re-querying.

### 2. Extract the markup route's TOU aggregation into a testable lib

`src/app/api/trmnl/markup/route.ts` contains ~250 lines of pure aggregation logic (the "Pass 1: prior day aggregates" and "Pass 2: today's raw rows" loops, tariff grouping, and net-grid cost computation). It is only exercisable through the route today. Move it into a lib function (new `src/lib/tou-aggregation.ts` or a method near `EnergyRepo`) with a signature like `(site, priorAggregates, todayRaw, schedule) => { tariffGroups, totalBillCost, seriesData, latestSeriesSoc }`, and add unit tests covering: schedule-id lookup vs. midpoint fallback, the today-row schedule-key caching, and credit (negative net grid) cost math. Before writing it, check whether the site dashboard (`src/lib/site-service.ts` / usage page) computes an equivalent aggregation that can share the same unit — per `Agents.md`, prefer extracting one cohesive unit over duplicating.

### 3. Reuse billing-cycle.ts in the markup route

The markup route hand-rolls billing-cycle math (parsing `toLocaleString` output, manual month decrement, a UTC-noon pivot date, `setMonth(+1)` for cycle end). `src/lib/billing-cycle.ts` already provides timezone-correct `getCurrentCycleStart` and `addMonthsInSiteTimezone` (used by the live and usage pages). Replace the hand-rolled block with those helpers so all three surfaces agree on cycle boundaries. Verify the rendered `dateRange` string is unchanged for a US-timezone site.

### 4. Retire the loose-pending linking flow if plugin_setting_id is reliable (Retained)

The "loose pending" fallback (installation row with NULL uuid and NULL plugin_setting_id, claimed by the next webhook within 15 minutes) exists for the case where setup can't identify the plugin. But `src/app/trmnl/install/page.tsx` already extracts `plugin_setting_id` from the TRMNL callback URL in both the auto-connect and manual paths, so the strong link should always be available. Check production data/logs for whether any `pending_loose` installations were created recently; if not, remove the loose path: the `pending_loose` branch in `src/app/api/trmnl/setup/route.ts`, the loose-claim branch in `src/app/api/trmnl/webhook/route.ts`, the loose-pending opaque-token match added in commit `1d85639`, and `findLatestLoosePending` in `src/lib/trmnl-installation-repo.ts`. This shrinks the webhook's attack surface. If loose installs do still occur, keep the flow and just note why here.

*Note (2026-07-01):* Checked the database and found 9 loose installations (including a recent one from June 23, 2026). Retained the flow as this fallback is still triggered (likely due to manual installation callback URL differences or transient `fetchMe` API issues).

## Remove Temporal polyfill after Node.js 26 LTS

`src/lib/billing-cycle.ts` now uses `@js-temporal/polyfill` for timezone-aware date arithmetic. Once Node.js 26 reaches LTS (~mid-2026), remove the polyfill dependency and use native `Temporal` from the runtime instead.

**Change:** Replace `import { Temporal } from '@js-temporal/polyfill'` with `import { Temporal } from 'temporal'` (or native global if available) and remove `@js-temporal/polyfill` from `package.json`.

## Node deprecation warning

```bash
(node:62351) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
```

## Investigate Tesla JWKS signature verification failures

**Status:** Implemented lazy refresh strategy with fallback to nonce-only validation (2026-05-12, fix-security branch).

Currently, Tesla ID tokens are signed with keys that don't appear in the public JWKS endpoint, even after lazy refresh with cache-busting headers. This appears to be a Tesla infrastructure issue (globally distributed CDN with eventual consistency, aggressive key rotation).

**Current behavior:** Authentication works via nonce validation (CSRF-secure), but signature verification fails.

**Next steps (when prioritized):**
1. Check if this affects production or is staging-only
2. Contact Tesla to understand key rotation grace period
3. Consider implementing key caching (keep recently-used keys for N hours)
4. Monitor error rates in production to assess urgency

**Related files:**
- `cmd/next-app/src/app/auth/tesla-callback/route.ts` - JWT verification with lazy refresh
- `Security.md` section 8 - Tesla `id_token` signature verification requirements


