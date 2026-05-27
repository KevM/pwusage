# Battery Hold Enhancements — Design

**Date:** 2026-05-25
**Status:** Approved design, pre-implementation
**Branch:** `feature/tesla-backup-reserve`
**Builds on:** [`2026-05-24-battery-hold-for-charging-design.md`](./2026-05-24-battery-hold-for-charging-design.md) (the shipped MVP)

## Problem

The shipped battery-hold MVP is a single click: park immediately at a computed
reserve, auto-restore via NILM with a fixed 16h safety backstop, and a blind
"Restore now" that always writes `original_reserve` back. Three gaps:

1. **No confirmation / no control.** A one-click park gives the user no chance to
   confirm or to say *how long* they want the hold or *what reserve* to hold at.
2. **Ambiguous reserve in the clamp band.** For SoC in 81–99 the Powerwall clamps
   any sent reserve to 80, so the only real options are 80 (discharge to 80, then
   hold) or 100 (hold completely). The MVP always picks 100. In the middle of the
   band that is a real trade-off the user should decide.
3. **Blind restore clobbers manual changes.** If the user changed the reserve in
   the Tesla app while a hold was active, "Restore now" (and every cron restore)
   overwrites it with `original_reserve`, silently undoing the user's intent.

## Goals

- Turn park and restore into a **two-step modal confirmation** that collects intent.
- Let the user choose hold **duration**: auto-detect (NILM) or a strict **N hours**.
- In the **ambiguous clamp sub-band (85–95)**, ask the user **80% vs 100%**; decide
  silently everywhere else.
- A **safety guard** in the shared restore path: never overwrite a reserve the user
  changed manually; cancel the hold without writing and tell the user.

## Non-goals

- No change to the NILM detection algorithm itself, the cron cadence, or the Tesla
  client beyond reading current reserve at restore time.
- No out-of-band notifications (no email/push — none exists in the app). Guard
  notices are surfaced in-app.
- No per-site persisted preferences for default duration/reserve (YAGNI).

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| What does "N hours" mean? | **Strict timer.** Hold the full N hours; NILM detection is OFF for that hold. "Auto-detect" keeps NILM + the 16h safety backstop. |
| Clamp-band edge defaults | **Snap to nearest:** 81–85 → 80, 95–99 → 100, ≤80 → floor(SoC), =100 → 100. Only **85–95** prompts (boundaries exclusive at 85/95). |
| Guard scope | Lives in the **shared `restoreBattery`**, so it covers manual restore *and* all cron restores (NILM, timer, safety). |
| Guard "unexpected" test | Current reserve `!==` the `target_reserve` we parked at (exact integer compare). |
| Guard notification | In-app, **persisted on the hold row**, dismissible. No email/push. |
| Confirm UI | **Modal overlay** (TagModal-style), for both Hold and Restore. |
| Duration input | **Quick-pick chips (2/4/6/8h) + a custom number field**, default 4h. |
| Notice persistence | **Dismissible + persisted** via `acknowledged_at` + a `dismiss` action. |

## Target-reserve rule (`lib/battery-hold-rules.ts`)

Replace the scalar `computeTargetReserve` with a planner that also reports ambiguity:

```ts
export interface ReservePlan {
  target: number;            // what to send if the user doesn't choose
  ambiguous: boolean;        // true only for 85 < SoC < 95
  options?: [80, 100];       // present iff ambiguous
}
export function planReserve(soc: number): ReservePlan;
```

Mapping:

```
SoC ≤ 80         → { target: floor(SoC), ambiguous: false }   exact hold, no prompt
80 < SoC ≤ 85    → { target: 80,        ambiguous: false }    settle to 80, silent
85 < SoC < 95    → { target: 100, ambiguous: true, options: [80,100] }   prompt
95 ≤ SoC < 100   → { target: 100,       ambiguous: false }    hold high, silent
SoC = 100        → { target: 100,       ambiguous: false }
```

Boundaries exclusive at 85 and 95 (matches "> 85 and < 95"): SoC exactly 85 → 80,
exactly 95 → 100. `holdButtonLabel` (in `battery-hold-format.ts`) and the modal both
read `planReserve`. When ambiguous, the user's explicit choice overrides `target`.

Prompt copy: **80%** = the Powerwall serves the load down to 80%, then holds (gives
up ~SoC−80%); **100%** = hold completely, no discharge.

`computeTargetReserve` is kept as a thin wrapper (`planReserve(soc).target`) only if a
consumer still needs the scalar; otherwise migrate callers to `planReserve`.

## Data model (`BatteryHold` migration)

New idempotent, timestamp-prefixed migration in `db-migrations/` (guarded
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`):

| Column | Type | Notes |
| --- | --- | --- |
| `mode` | text, `NOT NULL DEFAULT 'auto'` | `'auto'` (NILM + 16h safety) or `'timer'` (strict N-hour) |
| `acknowledged_at` | timestamptz, null | set when the user dismisses a guard-cancel notice |

Widened value sets (string columns, no enum change needed):

- `status`: `active` | `restored` | `failed` | **`cancelled`** (new)
- `restore_reason`: `load_ended` | `manual` | `safety_timeout` | **`timer_elapsed`** | **`reserve_changed`** (new)

`safety_expires_at` is **reused as the hard restore time for both modes**:
`created_at + 16h` in auto mode, `created_at + N h` in timer mode. No new expiry
column. The partial unique index (one active hold per site) is unchanged; a
`cancelled` hold is not `active`, so a new hold can start afterward.

`BatteryHoldRepo` gains:
- `createHold(...)` — extended with `mode`.
- `markCancelled(id, 'reserve_changed', currentReserve?)` — sets `status='cancelled'`,
  `restore_reason='reserve_changed'`, `restored_at=now()`, **without** a Tesla write.
- `getLatestCancelledUnacked(siteId)` — most recent `cancelled` + `reserve_changed`
  with `acknowledged_at IS NULL`, for the card notice.
- `acknowledge(id)` — sets `acknowledged_at = now()`.

## Service — park (`lib/battery-hold-service.ts`)

`parkBattery` deps gain `{ mode: 'auto'|'timer'; durationHours?: number; reserveChoice?: 80|100 }`:

1. Read live SoC + reserve as today.
2. `plan = planReserve(soc)`. If `plan.ambiguous` and no `reserveChoice` → return a new
   `{ status: 'needs_choice', options: plan.options }` result (defensive; the modal
   normally supplies it). Else `target = reserveChoice ?? plan.target`.
3. `safetyExpiresAt = now + (mode === 'timer' ? durationHours!*3_600_000 : SAFETY_HOLD_MS)`.
4. `setBackupReserve(siteId, target)`; clamp-surprise warning as today.
5. `repo.createHold({ ..., mode, targetReserve: target, safetyExpiresAt })`.

`ParkResult` gains `'needs_choice'`.

## Service — restore guard (shared)

`restoreBattery` reads current reserve before writing:

```ts
const info = await client.getEnergySiteInfo(siteId);
if (info.backup_reserve_percent !== hold.target_reserve) {
  await repo.markCancelled(hold.id, 'reserve_changed');   // NO setBackupReserve
  return { status: 'reserve_changed', current: info.backup_reserve_percent };
}
await client.setBackupReserve(siteId, hold.original_reserve);
await repo.markRestored(hold.id, reason);
return { status: 'ok' };
```

All targets (`floor(SoC)`, 80, 100) are non-clamped values, so the read-back equals
the sent value and an exact integer compare is reliable. `RestoreResult` gains
`{ status: 'reserve_changed'; current: number }`.

**Risk — `site_info` read lag.** The Fleet API documents `backup_reserve_percent`
read-back as lagging minutes (testing showed ~5s). A stale read could false-trigger
the guard, leaving the battery parked but the hold cancelled. Mitigations: exact-match
compare only (no fuzzy window that would widen false positives), and the cron path
runs well after the 5s observed freshness. Accepted for MVP; revisit if observed.

## Detection (`lib/battery-hold-detection.ts`)

`evaluateHold(hold, recentPower, now)` branches on `hold.mode`:

- `'timer'` → time check only: `now >= safety_expires_at` →
  `{ restore: true, reason: 'timer_elapsed' }`, else `null`. **NILM skipped.**
- `'auto'` → today's logic unchanged (safety timeout reason stays `'safety_timeout'`).

`RestoreDecision.reason` union gains `'timer_elapsed'`.

## Cron (`api/cron/restore-reserve`)

No structural change — it already calls `evaluateHold` then `restoreBattery`.
Additions:
- For `timer`-mode holds, skip `refreshTodayData` and the power-sample fetch (the time
  check needs no samples) — saves billable Tesla calls.
- Record the `reserve_changed` outcome in the results log.

## API route (`api/site/[id]/battery-hold`)

- `POST { action: 'park', mode, durationHours?, reserveChoice? }`:
  - Validate `mode ∈ {auto,timer}`; `durationHours` integer 1–24 when `timer`;
    `reserveChoice ∈ {80,100}` when supplied. Map `needs_choice` → `422 { error,
    options }`, `reserve_changed` is not possible on park.
- `POST { action: 'restore' }` → maps `reserve_changed` →
  `200 { status: 'reserve_changed', current }` so the UI shows the guard notice.
- `POST { action: 'dismiss' }` → `repo.acknowledge(latestCancelled.id)`.
- `GET` → `{ hold, notice }` where `notice` is the latest cancelled-unacked hold (or
  null), so the card can render the persisted guard message.

## UI — modal + card

### `ConfirmHoldModal` (new, TagModal-style overlay)

Props: `{ soc, plan, onConfirm({ mode, durationHours?, reserveChoice? }), onClose }`.

- **Reserve** radio rendered **only when `plan.ambiguous`** (80 vs 100) with the
  trade-off copy; otherwise the modal states the silent target ("Hold at 100% (max)").
- **Duration**: Auto-detect (default) vs Fixed. Fixed reveals quick-pick chips
  **2h / 4h / 6h / 8h** (default 4h) **+ a custom number field** (1–24h).
- Footer: **Cancel** / **Hold**.

A small confirm modal for **Restore** ("Restore reserve to MM%?", Cancel/Restore).

### `BatteryHoldCard` (orchestration)

- Idle → Hold button opens `ConfirmHoldModal`; on confirm, POST the choices.
- Holding → shows mode-aware copy ("Holding at NN% — auto-restores when charging
  ends" vs "…restores at <time> (N h)"). Restore button opens the confirm modal.
- **Guard notice**: when `GET` returns a `notice` (or a manual restore returns
  `reserve_changed`), render a dismissible `Alert`: *"Hold cancelled — your reserve is
  set to X% (changed outside the app), so we left it as-is."* Dismiss → `POST dismiss`.
  May also fire a `Toast` on the in-session manual path.
- Existing reauth/unavailable states unchanged.

## Data flow

- **Park:** click → modal collects `{ mode, durationHours?, reserveChoice? }` → `POST
  park` → service sets reserve = chosen target, writes hold with `mode` and the right
  `safety_expires_at` → card shows "Holding".
- **Auto restore (auto mode):** cron → NILM/safety → guard check → restore or cancel.
- **Timer restore (timer mode):** cron → `now >= safety_expires_at` → `timer_elapsed`
  → guard check → restore or cancel.
- **Manual restore:** confirm modal → `POST restore` → guard check → restore or
  `reserve_changed` notice.
- **Guard hit (any path):** reserve changed outside the app → hold `cancelled`, no
  Tesla write, `notice` persisted → card shows dismissible alert.

## Error handling & edge cases

- **Ambiguous SoC with no choice** → `needs_choice` (defensive; modal supplies it).
- **`durationHours` out of range / non-integer** → `400`.
- **Guard false-positive from stale `site_info`** → documented risk above; exact-match
  compare; accepted for MVP.
- **Token/scope `401`/`403`** → `needs_reauth`, unchanged.
- **Restore command fails after guard passes** → leave `active`, retry next tick, log
  (unchanged).
- **Concurrency** → partial unique index still enforces one active hold; `cancelled`
  frees the slot.

## Testing (TDD)

- `planReserve`: every band incl. exact 85/95/80/100 boundaries; `ambiguous` flag and
  `options` only in 85–95.
- `parkBattery`: timer vs auto `safety_expires_at`; ambiguous→`needs_choice` without
  choice; `reserveChoice` override; mode persisted.
- `restoreBattery` guard: current==target → restores; current!=target → `cancelled`,
  **no `setBackupReserve` call**, returns `reserve_changed`.
- `evaluateHold`: timer mode returns `timer_elapsed` only at/after expiry and **never
  runs NILM**; auto mode unchanged.
- Route: park validation (mode/duration/choice), restore `reserve_changed` mapping,
  `dismiss` acknowledges, `GET` returns `notice`.
- Repo: `markCancelled`, `getLatestCancelledUnacked`, `acknowledge`.
- UI: modal renders reserve radio only when ambiguous; duration chips + custom;
  guard `Alert` + dismiss.

## Sequencing

1. Migration (`mode`, `acknowledged_at`, widened value sets) + repo methods.
2. `planReserve` rule (TDD) + migrate callers.
3. `parkBattery` mode/duration/choice + `restoreBattery` guard (TDD).
4. `evaluateHold` timer branch (TDD).
5. API route (park validation, restore mapping, dismiss, GET notice).
6. Cron timer-mode short-circuit + result logging.
7. `ConfirmHoldModal` + `BatteryHoldCard` wiring + guard notice.

## Open questions / future work

- **`site_info` lag vs the guard** — if false positives appear in practice, consider
  confirming current reserve from a fresh `getLiveStatus`/command response rather than
  the cached `site_info`, or a short grace window.
- **Per-site default duration/reserve** — remembered preferences, deferred (YAGNI).
- **Timer + NILM hybrid** — a future "N hours but release early if charging clearly
  ended" mode was explicitly declined for now in favor of a strict timer.
