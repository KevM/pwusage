# TODO

Cross-session work that didn't fit the current focus. Pull from this list when picking up new work.

## How to use this list

When starting fresh work in this repo, check this file. If a session begins something here, leave a short note (date + branch/PR) under the item so the next session knows it's in flight. Once landed, delete the item.

## ROI F1 — Comparison-column past-dating (read-side pricing)

**Depends on:** the reporting-only comparison-tariff foundation (`docs/superpowers/specs/2026-06-13-roi-comparison-tariffs-design.md`), which already ships the `Tariff.effective_from` column (captured + displayed, not yet priced).

Wire the captured `effective_from` into the **comparison** columns (cells A/C/E): replace the current-version resolver with a per-row `resolveFixedBaseline(siteId, localDate)` that prices each rollup row at the comparison rate in effect on its date.

- Read-side, **no re-rollup** — the rollup stores rate-agnostic energies, so this is pure arithmetic and doesn't touch the metered `Schedule`.
- Corrects the fixed-baseline history (the originating $0.16580→$0.19342 overstatement on early years) and removes the spec's "historical rates not yet applied" note.
- **Out of scope:** future-dated rate changes (unknowable forward; projection carries the latest rate flat).

## ROI F2 — Metered historical correction (Schedule date-resolution + re-rollup)

**Depends on:** the `effective_from` column from the foundation phase (independent of F1).

Make the **metered** `Schedule` resolve the version whose `effective_from` window covers a timestamp (with `is_current` fallback so undated versions behave exactly as today; `getTariffPeriodByComponents` currently ignores the year and first-matches across versions). Then re-replay 5-min history through the corrected schedule (reuse the history-indexing backfill).

Cell F's TOU rate is snapshotted into each `EnergyRollup` at write time and the row is keyed by the version's `tariff_schedule_id`, so an in-place re-price won't do. Closes "the hole where my past tariff period is not representative of reality."

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


## Phase 2: ROI Report & Counterfactuals

**Status:** Ready to begin. Stored rates and energy flows are now recorded in `EnergyRollup` per period.

**Task:** Implement read-time derivations (discharge source split, discharge cost basis, arbitrage P&L) and reporting UI. This is unblocked by the Battery Power Provenance data foundation.



