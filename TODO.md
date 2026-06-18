# TODO

Cross-session work that didn't fit the current focus. Pull from this list when picking up new work.

## How to use this list

When starting fresh work in this repo, check this file. If a session begins something here, leave a short note (date + branch/PR) under the item so the next session knows it's in flight. Once landed, delete the item.

## Flat-file archive for old EnergyData (retention escape hatch)

**Context:** As of 2026-06-15 (`feat/roi`), `DATA_RETENTION_DAYS` defaults to `0` = keep forever (`src/lib/retention.ts`), so raw 5-minute `EnergyData` is never pruned and the history backfill persists every day. This is what lets the Savings feature re-bucket raw energy into arbitrary tariff TOU windows across full history — it **supersedes the old "2b" plan-agnostic hourly-profile idea** (we keep raw samples instead of a derived hourly aggregate).

**Deferred work:** before unbounded `EnergyData` becomes a storage problem (projection: ~30 MB/active-site/year, ~0.45 GB/yr for the current active base — comfortable for years), build a cold-storage archive: export old raw samples to flat-file storage (e.g. Vercel Blob) and re-hydrate them on demand for savings calculations, so a finite live DB window can be reintroduced without losing the ability to price historical plan-vs-plan comparisons.

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

