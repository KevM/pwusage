# TODO

Cross-session work that didn't fit the current focus. Pull from this list when picking up new work.

## How to use this list

When starting fresh work in this repo, check this file. If a session begins something here, leave a short note (date + branch/PR) under the item so the next session knows it's in flight. Once landed, delete the item.

## Remove Temporal polyfill after Node.js 26 LTS

`src/lib/billing-cycle.ts` now uses `@js-temporal/polyfill` for timezone-aware date arithmetic. Once Node.js 26 reaches LTS (~mid-2026), remove the polyfill dependency and use native `Temporal` from the runtime instead.

**Change:** Replace `import { Temporal } from '@js-temporal/polyfill'` with `import { Temporal } from 'temporal'` (or native global if available) and remove `@js-temporal/polyfill` from `package.json`.

## Update trmnl markup with Framework 3.1

A new font has been introduced to look better on eInk displays.

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

## TRMNL chart hour labels should use site timezone, not server timezone

**Status:** Pre-existing on `main`; surfaced (but not introduced) by the snapshot
tests added on `feature/trmnl-load-timing-widget` (2026-05-19, PR #55). Worked
around in tests by pinning `process.env.TZ = 'UTC'` in `cmd/next-app/vitest.setup.ts`.

`buildHourLabelEntries` in `cmd/next-app/src/lib/trmnl/charts.ts` computes the
"12am / 6am / 12pm / 6pm" tick positions by calling `Date.setHours(h, ...)`,
which uses the **process** timezone. On Vercel (UTC), this means every site —
regardless of physical location — sees the chart's hour ticks anchored to UTC
midnight, not the site's local midnight. For a California user this skews the
"12am" tick by 7–8 hours.

**Fix:** Plumb `site.timezone` from `src/app/api/trmnl/markup/route.ts` into
`TrmnlRenderer.renderFull` / `renderChart`, and compute the tick clock-times
in that zone (e.g. via `Intl.DateTimeFormat` or the same Temporal polyfill
used in `billing-cycle.ts`). Once the renderer takes a `tz`, the snapshot
tests should pass it explicitly and the `TZ=UTC` pin in `vitest.setup.ts`
can stay as belt-and-braces or be removed.
