# Design Decisions — Why Things Are The Way They Are

Read this before "simplifying" anything it describes. Each item below looks like
it could be shortened, generalized, or deleted — and each one is load-bearing.
`CLAUDE.md` and `Agents.md` tell you *how* to work in this repo; this doc records
*why* a handful of non-obvious decisions were made, so a well-meaning refactor
doesn't quietly reintroduce a bug that was already paid for.

The rationale here originally lived only in plan docs (`docs/superpowers/plans/`,
`cmd/next-app/docs/plans/`) and merged PR descriptions. When you change one of
these areas, update the matching section here too.

---

## 1. Cross-instance claim pattern (billable Tesla calls)

**Decision:** Before making a billable Tesla Fleet API call from a path that can
run concurrently, "claim" the work with an atomic conditional `UPDATE` on a
`Site` column and treat `rowCount` as the verdict. Two live examples:
`acquireImportLock` (used by `refreshTodayData`) and `claimLiveRefresh` /
`releaseLiveRefreshClaim` (used by `refreshLiveStatus`), all in
`src/lib/site-repo.ts` + `src/lib/today-refresh.ts`.

**Why it exists:** The app runs on Vercel serverless. In-process throttles
(`globalThis.__todayRefreshState`, in-memory maps) do **not** span instances, so
two concurrent requests — e.g. a TRMNL markup poll and a web live-page load — hit
a cold/expired cache and each make the same billable Tesla call. The atomic
conditional `UPDATE ... WHERE last_live_refresh_at IS NULL OR <= now - interval`
lets exactly one instance win; losers return `cached`/`throttled`, which is what
they wanted anyway.

**Guardrails — do not "simplify" by:**
- Removing the DB claim and trusting the in-process throttle. That is the exact
  bug this replaced; in-process state is per-instance.
- Reusing the import lock for live-status refreshes. They are deliberately
  separate columns/claims — sharing one would make a live-status refresh block a
  data import (and vice versa).
- Dropping the failure-path release (`releaseLiveRefreshClaim`). It restores the
  pre-claim value via compare-and-set so a failed fetch doesn't lock out retries
  for a full interval, *and* doesn't clobber a fresher write from a `force`
  caller. Tests pin this ("does not report in-flight or lock out cold cache
  retries after a failed fetch").
- Making `force` go through the claim. `force: true` intentionally bypasses it —
  the caller explicitly wants a fresh fetch.

**Known, accepted edge:** the claim advances `last_live_refresh_at` a few seconds
before the fetch completes, so the SoC-age/staleness display can look slightly
fresher than reality for a moment. Judged acceptable versus duplicate billable
calls. (See `docs/superpowers/plans/2026-07-03-live-status-claim-and-token-guard.md`.)

---

## 2. Append-only tariff versioning

**Decision:** `Tariff` rows are append-only. Each save inserts a new version
(`version` + `is_current` on the `Tariff` root, deduped by `content_hash`) and
flips the previous current row to `is_current = false`. There is no
delete-and-reinsert. `EnergyData`'s UNIQUE key is `(timestamp, site_id)` —
**not** `(timestamp, site_id, tariff_id)`. (PR #63; `src/lib/tariff-repo.ts`,
`src/lib/energy-repo.ts`.)

> The authoritative uniqueness key is `(timestamp, site_id)` — see
> `ON CONFLICT(timestamp, site_id)` in `energy-repo.ts`. The `tariff_id`
> *column* is retained for billing aggregation but is not part of the key.

**Why it exists:** The old replace-tariffs-for-site path deleted and reinserted
`Tariff` rows, which caused two real problems:
1. An importer FK race on the changing tariff IDs (which is why the now-deleted
   `remapTariffIds` existed).
2. A latent `ON DELETE CASCADE` that would wipe historical `EnergyData` when a
   tariff row was deleted.
Append-only makes tariff IDs stable forever, so history never dangles. Validated
against the production corpus (PG 17.6): 0 constraint conflicts.

**Guardrails — do not "simplify" by:**
- Reintroducing delete/replace of `Tariff` rows, or adding `ON DELETE CASCADE`
  from `EnergyData` → `Tariff`. History must survive tariff edits.
- Adding an `is_current` filter to the billing name/rate resolution. Historical
  `EnergyData` rows point at *old* tariff versions; billing must resolve names
  and TOU rates across **all** versions or old rows render as "Unknown". This is
  deliberate and commented in `tariff-repo.ts` ("No is_current filter on
  purpose") and `tou-aggregation.ts`. Only the live `Schedule` / `site.tariffs`
  load is current-only.
- Removing `content_hash`. It's the idempotency key — re-saving identical tariff
  content is a no-op instead of a spurious new version. The insert is serialized
  by locking the parent `Site` row to keep the check race-free.

---

## 3. Loose-pending TRMNL installation flow

**Decision:** `POST /api/trmnl/setup` may create a "loose pending"
`TrmnlInstallation` row with **NULL `uuid` and NULL `plugin_setting_id`** — just
`site_id` + the Trmnl access token. The next Trmnl webhook to arrive within a
15-minute window claims it (`getLatestLoosePendingInstallation` →
`claimPendingInstallationById`). See `src/app/api/trmnl/setup/route.ts` and
`src/app/api/trmnl/webhook/route.ts`.

**Why it exists:** At setup time we try three ways to learn the device UUID (OAuth
response fields → JWT decode → Trmnl `/api/me`). All three can fail. When they
do, we still want the install to succeed, so we persist what we have and let the
webhook — which *does* carry `user.uuid` and `plugin_setting_id` — finish the
link. The matching is intentionally loose (most-recent, time-boxed) because the
setup call and the webhook can't always be correlated by ID.

**Why it's safe here:** this is a single-user / sequential-install personal app,
so "the most recent loose pending record within 15 minutes is the one this
webhook belongs to" holds. The 15-minute window and most-recent heuristic bound
the mis-claim risk.

**Guardrails — do not "simplify" by:**
- Deleting the loose-pending fallback because the UUID "should always be
  available." It isn't always; removing it makes installs silently fail when
  UUID resolution fails.
- Widening or removing the 15-minute freshness window, or matching without it —
  that's the safety bound against claiming an unrelated install.
- Assuming this generalizes to multi-tenant. If this app ever becomes
  multi-user, the most-recent heuristic must be replaced with a real correlation
  token; flag it, don't quietly keep it.

The webhook path also still requires the opaque token to match the stored
`access_token` (timing-safe) before claiming — the loose match narrows *which*
row, it does not replace authentication.

---

## 4. Battery provenance = relative flow accounting (no SOC, no genesis seed)

**Decision:** The battery cost-basis "tank" is **relative flow accounting**, not
an absolute state-of-charge gauge. It adds observed charge (valued at the hour's
metered rate), removes observed discharge proportionally, tracks the solar/grid
cost blend, and clamps to non-negative. It never reads absolute battery fullness
(`battery_soc`). One-time genesis seeding (`computeGenesisSeed`) was **removed**
in Phase C2; on-read arbitrage starts from an empty tank.

**Why it exists / why genesis was dropped:** Absolute `battery_soc` fed *only*
the genesis anchor (cost basis for energy already in the battery before the data
window). But `battery_soc` is populated only from Tesla SOE history, and the
`index-history` backfill runs `new Importer(client, { fetchSoe: false })` to
halve Tesla calls and avoid 429s — so every backfilled row has
`battery_soc = null`. Genesis therefore never anchored for the bulk of history;
it was already a no-op. Dropping it removed dead complexity, not real behavior.

**Cost of dropping it:** the only loss is un-attributable early discharges — at
most ≈1 battery-capacity of discharge at the very start of history. It's bounded
and non-accumulating (self-corrects after one charge/discharge cycle).

**Guardrails — do not "simplify" or "improve" by:**
- Re-adding SOC-based cost basis / genesis seeding to "make provenance more
  accurate." It looks like a gap; it's a deliberate no-op removal. If true
  startup attribution is ever genuinely wanted, raw 5-minute `EnergyData` is kept
  forever, so SOE for just the genesis window can be re-fetched — do that, don't
  resurrect the old anchor.
- Feeding `battery_soc` into the tank as if it were reliable. It's frequently
  NULL on backfilled rows.

(See the Phase C2 plan's "Decision: no genesis seeding" section.)

---

## Cross-reference: superseded architectural review

`cmd/next-app/docs/plans/2026-05-21-architectural-review.md` is partly generic
boilerplate and contains claims that don't match the codebase. It carries a
supersession banner. **Verify any claim there against current code before acting
on it.**
