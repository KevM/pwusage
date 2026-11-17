# Rate plan selection, review, and restoration

Status: approved product direction, 2026-11-17. The implementation details below
make that direction concrete; they have not been implemented.

Implementation: [implementation plan](2026-11-17-rate-plan-selection-implementation.md).

## Problem

PWUsage automatically combines saved Tesla plans and public utility rates, but
people cannot consistently see or correct those choices. The public plan picker
only appears for `needs_plan`, and the backend ignores a selected public plan
when a usable Tesla plan exists. Public lookups also lack a US eligibility gate.

A wrong Tesla plan has two consequences: PWUsage can calculate misleading bill
and savings estimates, and the Powerwall can optimize against outdated prices.
Changing PWUsage's calculation plan does not update the Powerwall.

## Agreed experience

Rate Plans communicates two independent selections:

- **Your rate plan:** the plan used to price the household's energy.
- **Fixed comparison plan:** the baseline used for savings comparisons.

Show plan name, utility when known, effective dates, rate details, source, and
whether the selection was automatic or chosen by a person. Source labels are:

- **From Tesla**
- **From public utility rates**
- **Entered by you**

Use **Verified by you** separately from source. Other household viewers must not
see someone else's verification described as their own. Public rates retain an
estimated label even when the user verifies them. Reserve the full name
“OpenEI Utility Rate Database” for source details and attribution.

Keep **Change Plan** available after automatic setup and after an override. It
offers a public plan where eligible, or manual entry everywhere. Reuse existing
manual season and rate-period editing. The fixed comparison plan has its own
change action; changing it never replaces the actual plan.

## Required dates and review

There is **no default effective date**. The start date is initially unset and
must be explicitly selected. Users may backdate within existing supported date
bounds. Let them choose an end date or explicitly choose an ongoing range.
Display public revision dates as information, never as a preselected start date.

All replacements, manual edits, and restorations pass through a review step
before a timeline mutation. Review shows:

1. The selected effective date range, using the site's calendar dates.
2. Each affected existing plan and its replacement, with plan name and source.
3. Usage rates (energy bought from the grid) and production rates (energy sold
   to the grid), including units, currency, seasons, weekday/weekend windows,
   and applicable holiday handling.
4. Any gaps that gain coverage and any period outside the chosen range that
   stays in place. Split the comparison at every existing-plan boundary.
5. Whether historical bill and savings estimates will be recalculated.

Do not compare plans only by Peak/Off-Peak names: their windows can differ. Align
comparison rows by season/date and time boundaries, and show both schedules.
Explain any public-rate approximation, including tier blending and inherited
export rates; do not present an inherited export rate as a published one.

Suggested warning for an actual-plan override:

> This changes the rates PWUsage uses for bills and savings estimates. Your
> Powerwall will continue using the plan saved in Tesla. Check the prices, time
> periods, export rates, and effective date against your utility bill.

Review acknowledgement is required to apply a change. A separate, initially
unchecked **I checked these details against my utility bill** option records
user verification. Applying an override need not falsely claim bill verification.
Editing the plan or dates after review requires a fresh review. Cancel changes
nothing. If the server's affected timeline or candidate rates change, show the
updated comparison and require review again.

## Source, ownership, and verification are separate

Preserve immutable tariff versions. Effective periods decide which version is
used on which dates. A public plan chosen by the owner remains public/estimated
in origin, but its selected period is protected from automatic replacement.
Do not use `source = manual` to disguise a public selection, or let
`source = estimated` make an explicit selection disposable.

Store selection provenance and verification against the exact tariff content
and effective range. Record verifier and verification time. Changes to prices,
schedules, plan identity, or effective dates invalidate verification for the
changed selection. Unchanged historical verification remains auditable.

Future Tesla imports and public-data refreshes preserve explicit selections.
They may offer new rates for review, but must not silently alter selected
content, dates, or verification. This rule also applies to explicit selections
in the reference timeline. Automatic estimates still fill unprotected gaps.

## Restore Original Tesla Rate Plan

Use the exact action label **Restore Original Tesla Rate Plan**. Preserve the
Tesla version replaced by an override, including its complete rates and content
identity, even if it no longer owns any effective period.

Restoration selects the saved original version and requires dates and the same
before/after review. Apply that immutable version to the selected range without
erasing the intervening override or older history. It does not send a Powerwall
command. Restoration is an explicit selection of a saved version, not an
implicit opt-in to future automatic replacements.

If an override replaced multiple Tesla versions, retain the originals per
affected interval and show which one applies to each interval when restoring.
If no Tesla original exists for an interval, explain that restoration is
unavailable there. Never substitute the newest import for the saved original.

## Powerwall mismatch and outdated-plan warnings

Keep the plan used by PWUsage distinct from the latest plan observed in Tesla.
Compare actual schedules and buy/sell rates, not only plan names. A mismatch
notice must say that PWUsage's plan differs from the plan last read from Tesla;
include observation freshness rather than implying an old snapshot is live.

The existing `teslaPlanOutOfDate` signal follows a matched URDB revision's
successor chain. Surface it prominently, with the newer revision's date, but
describe it as a possible outdated Tesla plan, not proof of the customer's
actual utility contract. Owners can check their bill, override PWUsage's plan,
or update Tesla and sync. A missing public match is not proof of current rates.

The separate public-estimate age warning remains distinct. Neither warning
automatically changes a selected plan or its verification.

## US eligibility and existing solar location

URDB eligibility is per site: `us`, `outside_us`, or `unknown`. Keep it separate
from processing state (`pending`, `ready`, etc.) and user opt-out.

The app already stores an approximate solar home location, rounded to two
decimals, on-device and in private iCloud. The server-side `SiteSolarLayout`
table was dropped in migration `20261101120000`. Reuse the saved location on
the device to derive country where possible. Send only country code and its
provenance to PWUsage, never coordinates or panel layout for rate eligibility.
Country resolution must have a documented boundary-data/provider choice and
an uncertain result near borders; do not approximate the US with a rectangle.

Ask the user for site country only when existing information cannot resolve it.
Explicit correction takes precedence over inferred country. A changed saved
location invalidates its prior country inference; failed inference returns
unknown, not US. Do not infer eligibility from USD, timezone, phone location,
or Tesla API region.

Enforce eligibility in cron and all public utility/plan endpoints, as well as
the UI. Unknown sites are not sent to a misleading US utility picker. Outside
the US, keep Tesla/manual entry available and explain that public utility plans
are currently available for US sites. Existing non-US public selections need a
visible correction path; preserve their audit records, remove automatic public
coverage through the normal repricing path, and require review before replacing
any explicit owner selection. Do not delete manual or Tesla plan history.

Update privacy and utility-picker text to describe country inference accurately.
Coordinates must remain absent from URDB requests and server logs.

## Storage and transaction constraints

Extend the existing tariff/effective-period model rather than build another
pricing engine. Add provenance for protected selections, restoration originals,
and content/range-bound verification. The exact schema belongs to implementation.
Backfill existing owner-edited selections as protected, without inventing prior
verification. Preserve existing public source mappings across estimate refreshes.

Preview and commit share validation, conversion, and overlap planning. Commit
rechecks a deterministic review fingerprint against current affected periods,
candidate content, and eligibility under the site lock. A conflict requires a
fresh review. Save the selection and enqueue repricing atomically. Network
lookups must not hold the database site lock. Reference-only changes must not
reattribute actual energy or mutate actual-plan selection.

## Verification and rollout

Test backdated changes crossing several plans, finite/open-ended ranges,
stale-review conflicts, duplicate submissions, preservation during Tesla and
URDB refreshes, original restoration, and verification invalidation. Cover
actual and reference scope independently, source/verification presentation,
country changes, no-location and border uncertainty, and access isolation.

Review the complete iOS flow at large text sizes and with VoiceOver. Run the
app-specific checks from both AGENTS.md files before implementation completion.
Older clients must continue decoding additive contract fields; new clients
must tolerate an older server without presenting unsupported actions.

## Follow-up: update the Powerwall

After this UX is working well, investigate publishing the verified, currently
active plan to Tesla. That needs API-capability research, a distinct explicit
confirmation explaining effects on Powerwall behavior, fresh authorization,
concurrency handling, and readback/reconciliation of uncertain results.
Verification or saving in PWUsage never triggers that write in this phase.
