# Smart Shift jobs: quick EV charge editing and job templates

Status: draft for approval · iOS only (`cmd/ios-app`, Smart Shift tab) · 2026-11-10

## Why

The main reason the owner uses Smart Shift is to decide **when to charge an EV**. The estimate
is only as good as the car's current charge, and today that is expensive to keep accurate:

- Current charge lives inside the saved job. Updating it means Manage Jobs → edit sheet → a
  stepper that moves 1% per tap (15 taps to go from 20% to 35%).
- Switching between the household's two EVs is: scroll → "Try another job" → pick job → open its
  edit sheet → edit current charge → back. About five steps, repeated every plug-in.
- There is exactly one car. The household has two with different battery sizes, so battery size
  is edited back and forth.
- The five starter jobs (car, dishwasher, washer, dryer, combo) can never be deleted, only reset.
  Other households and uses (cooking, pool heating, other appliances) can't be modelled well.

Typical use: the car is at 20–40% when plugged in, and the car used last is usually the one to
charge again. Winter trips sometimes raise the target charge. Precision isn't needed; this is an
estimate.

## Goals

1. **Fast current-charge entry.** Set current charge (and target) in one drag or a few taps, in
   5% steps.
2. **Fast car switching.** Switching EV is one tap; the last-used EV is already selected.
3. **Multiple EVs**, each with its own battery size, charging level, target and current charge.
4. **Every job is an ordinary job**: add, edit, duplicate, delete. No undeletable built-ins.
5. **Templates**: adding a job starts from a short list of starters (EV, dishwasher, laundry,
   blank custom) instead of an empty form.
6. **Quick custom jobs**: a custom job is set by a Small / Medium / Large size plus roughly how
   long it runs, with step sizes that scale with the size.
7. **Pluggable shape.** A job's special behaviour and its data source are separable, so a later
   Tesla Vehicle API sync can supply an EV's current charge without reworking the model.

## Non-goals

- **Tesla Vehicle API integration.** Not now. Only leave a clean seam (see Pluggability).
- Automatic estimation of drift in the current charge (e.g. "it was 30% yesterday, so probably
  lower or higher now"). Charge is whatever the person last set.
- Cross-device sync of jobs. Jobs stay on the device (UserDefaults), as today.
- Any change to the Next.js app or the mobile ⇄ web contract. This feature is iOS-local.
- Per-job power/curve modelling for non-EV jobs beyond "energy over some hours".
- Changing the Smart Shift timing/estimation algorithms themselves.

## Anti-goals

- Anything that makes the common path (open Smart Shift → set charge → read the answer) take
  more taps than today. Additions such as templates must not push setup friction onto it.
- False precision: don't present 1% or 0.1 kWh controls as the primary way to edit.
- Losing existing users' saved jobs or their edits on upgrade.
- A job-type framework heavier than the two real kinds that exist (EV and everything else).

## Decisions made with the owner

- **Quick edit UI: a summary line plus a quick sheet** (mockup option B).
  - The Smart Shift card shows one line, e.g. `Model Y · 30% → 80%`, with an Edit affordance.
  - Tapping opens a small half sheet containing: car chips (switcher), a **current charge**
    control, and a **target charge** control.
  - Charge controls move in **5% steps** (a ±5 control and/or a 5%-segmented slider; builder
    chooses what feels best, but 5% granularity is fixed).
  - The last-used EV is selected by default. Battery size and charging level are *not* in this
    sheet; they are per-car setup, edited in Manage Jobs.
- **Per-car setup vs per-plug-in state.** Battery size, charging level are set once per car.
  Current charge changes every plug-in. Target charge changes occasionally (longer trips,
  winter). The quick sheet therefore exposes current + target only.
- **Order of work: two phases, one design.**
  - Phase 1 (the daily pain): ordinary/deletable jobs, multiple EVs, quick charge sheet, 5% steps,
    storage migration.
  - Phase 2: template picker for adding jobs, Small/Medium/Large custom jobs, Tesla seam hardened
    and documented.
- **Custom jobs use Small / Medium / Large.** Larger sizes use larger step sizes. For example, a
  Large job moves in ~5 kWh steps, not 0.5 kWh. Exact kWh/hours remain reachable but are not
  the primary control.

- **The EV summary line shows only while an EV is the selected job** (owner, 2026-11-10). It does
  not stay on the card when another job such as the dishwasher is selected. Reaching an EV from
  another job is the existing "Try another job" picker; the card then shows that EV's summary
  line and quick sheet.

## Builder-check calls (author's decisions, not the owner's)

- **Job shape:** keep `kind` (`car | appliance | custom`). Add an optional stored `size`
  (small/medium/large) used by custom jobs. Existing appliances keep exact kWh/hours and no
  size. The size is stored, not derived from `energyKwh`. Custom ids stay UUIDs; the seeded
  `custom-example` stays a normal custom job.
- **Last-used EV:** the selected job if it is an EV, otherwise the most recently selected EV,
  remembered in one extra persisted id. The quick sheet's car chips list EV jobs only.
- **Empty states:** Phase 1 adds a minimal "Add a Car" next to "Add a Custom Job" so deleting
  everything is recoverable before templates ship. Phases can ship independently.
- **Estimators and widgets:** the builder verifies no code assumes the id `car` or a single
  car job. The widget and Live Activities don't read load profiles (checked 2026-11-10).
- **Charge source:** a runtime protocol with a single `manual` implementation; nothing new is
  persisted.
- **Off-grid charge values** (e.g. 37% from the old 1% stepper): shown exactly, snapped to the
  nearest 5% on first edit; target is re-clamped to stay at or above current.
- **Sheet presentation:** small detent with background interaction enabled, so the card's answer
  stays visible and updates live while dragging.

## Current state (for the builder)

All in `cmd/ios-app/PWUsage`:

- `Models/LoadTiming/LoadProfile.swift`: `LoadProfile` (`id`, `name`, `kind: car|appliance|custom`,
  `energyKwh`, `durationHours`, `carSettings?`) and `CarLoadSettings` (`capacityKwh`,
  `initialStateOfCharge`, `targetStateOfCharge`, `chargingLevel`).
- `State/LoadTiming/LoadProfileStore.swift`: persists `[LoadProfile]` + `selectedProfileID` as
  JSON in UserDefaults (`pwusage.loadProfiles.v1`, `schemaVersion = 2`). Seeds six profiles with
  fixed ids (`car`, `dishwasher`, `washer`, `dryer`, `washer-dryer-combo`, `custom-example`);
  validation *requires* those built-in ids to exist and be of the same kind; only `.custom`
  jobs are deletable; custom ids must be UUIDs; built-ins can only be reset.
- `Views/LoadTiming/LoadProfilesSheet.swift` (Manage Jobs list), `ProfileEditorSheet.swift`
  (editor with 1% / 0.5 steppers), `ProfileDraft.swift`.
- `Views/LoadTiming/LoadTimingView.swift`: card, "Try another job" disclosure → job picker sheet;
  `selectJob`, `selectedProfile`.
- `kind == .car` is branched on in roughly six places (estimator
  `LoadTimingEstimator.carChargeEstimate`, `LoadTimingForecastEstimator*`,
  `SmartShiftPresentation+Messages`, `LoadTimingPresentation`). Charging power/efficiency
  are hard-coded by level (L1 1.5 kW @ 85%, L2 9 kW @ 90%).
- Copy rules: `docs/voice-and-terms.md` (never bare "job"; "Smart Shift", "Try Another Job",
  etc.). Follow it for all new strings. iOS conventions and the lint/test commands are in
  `cmd/ios-app/AGENTS.md`.

## Design

### Job model

Jobs remain one list of ordinary jobs. The built-in/non-removable distinction goes away: the
starter jobs become normal jobs seeded once on first run and then owned by the user. Keep the
two real behaviours as the model's seam (EV vs. everything else) rather than adding a general
plugin system.

Requirements the builder must satisfy:

- Any job can be deleted, duplicated, renamed and edited. Deleting the selected job selects
  another; deleting the last one yields the existing "no jobs" state.
- Multiple EV jobs may exist; each has its own `CarLoadSettings`.
- Job identity is not tied to fixed ids; existing saved ids (`car`, etc.) remain valid as
  ordinary ids.
- "Reset to defaults" for starters goes away (or becomes "re-add from template"); builder's call.

### Quick charge sheet

Behaviour in "Decisions" above. Additional requirements:

- Appears for the selected job only when it is an EV; non-EV jobs keep their current card.
- Edits apply to the stored job immediately (no Save/Cancel). Dismissing the sheet leaves the
  latest values in place.
- Target can never be below current; moving current above target raises target (matches today's
  editor).
- The Smart Shift answer on the card reflects changes when the sheet closes at the latest;
  live update while dragging is preferred if cheap.
- The car switcher in the sheet lists EV jobs only and changes the selected job.

### Templates (phase 2)

"Add a job" opens a short template list, each producing a normal, editable job:

- EV (with sensible battery size/level defaults)
- Dishwasher, Laundry (wash / dry / combo, matching today's starters)
- Custom (Small / Medium / Large)

Template data is a plain list of starter definitions (name, kind, defaults), not code per
template, so adding a template is adding data.

### Small / Medium / Large custom jobs

A custom job is described by a size (Small / Medium / Large) and a run duration in hours. Each
size maps to an energy amount and a step size for adjusting it (Large ≈ 5 kWh steps). Exact
kWh/hours stay editable in a detail view. Exact preset values are the builder's call (see "Left
to the builder").

### Pluggability (Tesla seam, not built)

The EV's current charge must come from one place that today is manual entry. Define a small
abstraction (e.g. a "charge source" for an EV job whose only implementation now is `manual`).
A future Tesla implementation would update the same stored current charge, and the quick sheet
would show it as read-only/"synced" instead of editable. Nothing in this design calls any Tesla
API.

### Migration

- Bump the `LoadProfileStore` schema version; decode v1 and v2 payloads as today.
- Existing users' six jobs keep their ids, names and edits and simply become ordinary jobs
  (deletable). No job is dropped or re-seeded over a user edit.
- Fresh installs seed the starter set once.
- `selectedProfileID` is preserved.

## Constraints

- iOS only; no Next.js / API / contract changes. No `MobileLiveContract` change.
- Jobs remain on-device in UserDefaults.
- Must pass `./cmd/ios-app/lint.sh` clean (SwiftFormat + SwiftLint `--strict`) and zero compiler
  warnings; tests via `cmd/ios-app/run-tests.sh`. Follow the TDD and test-timeout guidance in
  `cmd/ios-app/AGENTS.md`.
- All copy follows `docs/voice-and-terms.md`.
- Large Dynamic Type and VoiceOver must work for the quick sheet (existing sheets already
  handle accessibility sizes).
- Smart Shift estimation must not slow down: switching jobs and dragging charge stay responsive
  (the card re-evaluates per change).

## Left to the builder

- Control for 5% charge steps (±5 buttons, segmented slider, or both).
- Exact S/M/L energy values and step sizes; default hours per size.
- Template list contents beyond the four named, and their default values.
- Wording within the voice-and-terms rules; icons.
- Whether "Reset to Defaults" is removed or replaced by "re-add from template".
- Internal type names, file layout, and test structure.

## Success

- From the Smart Shift tab, switching to the other EV and setting its current charge takes **at
  most two taps plus a drag** (open sheet, tap the car, set charge), versus five steps today.
- Setting current charge from 20% to 35% takes at most three ±5 taps or one drag, versus 15.
- The household can have two EVs with different battery sizes saved side by side.
- A user can delete every starter job and add a custom job in Small/Medium/Large without
  entering kWh.
- Existing installs keep all saved jobs and edits after upgrading.
