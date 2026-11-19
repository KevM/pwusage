# Sync to Tesla: send the current rate plan to the Powerwall

Status: design, 2026-11-19. Follows the write probe ([findings](../../tesla-tou-write-probe.md),
PR #360) and rate plan selection ([design](../../plans/2026-11-17-rate-plan-selection-design.md),
PR #393), which left "update the Powerwall" as a follow-up.

## Why

PWUsage does a lot to help people find and enter the right rate plan, for history and for
today. When someone knows Tesla holds an out-of-date plan, they currently have to re-enter
seasons, hours and prices by hand in the Tesla app. PWUsage already has the right plan.
**Sync to Tesla** sends it: one press, a confirmation, done.

## Goals

- Send the plan PWUsage uses **today** (the actual plan, not the fixed comparison plan) to
  Tesla when it differs from the plan last read from Tesla.
- Every send is an explicit press plus a confirmation that explains the Powerwall effect.
- Tell the person what really happened: Tesla confirmed it, or it was sent but not yet confirmed.

## Non-goals

- Sending history or future-dated plans. Tesla holds one current plan; PWUsage does not
  support plans that end in the future.
- A standing "keep Tesla up to date" setting or any automatic write.
- Web UI in this phase (it arrives with the web rate-plan editor in `TODO.md`).
- Sending the fixed comparison plan.

## Anti-goals

- **Fighting the Tesla app.** If someone changes the plan in the Tesla app, they win. PWUsage
  never writes back on its own; the next import records their plan and the existing
  "PWUsage's rate plan differs from Tesla's" notice returns. Only a person's press sends again.
- A write triggered by saving, verifying or restoring a plan in PWUsage.
- An optimistic "Done" when Tesla has not confirmed.
- Losing the pre-upload Tesla plan (Restore Original Tesla Rate Plan must still find it).

## Behavior

**When the button shows.** Only when today's PWUsage plan differs from the latest Tesla plan.
Today this is `teslaSync.differsFromActiveManual` in `tariff-timeline-repo.ts`, which compares
`content_hash`. That hash will not match after a successful upload if Tesla normalizes or adds
fields, so the comparison must be **semantic**: seasons and their date ranges, weekday/weekend
time windows, buy and sell prices per period, currency. Plan names and fields PWUsage does not
model are ignored. The same comparison drives the existing notice, so notice and button always
agree. If today's plan *is* Tesla's own import, there is nothing to send.

**Where it shows (iOS).**
1. On the existing divergence banner (`TeslaDivergenceCopy`, `TariffSheet+Banners.swift`):
   a **Sync to Tesla** action.
2. As an optional last step after someone applies a change that affects today's actual plan in
   the reviewed selection flow: "Also update your Powerwall?" with **Sync to Tesla** and
   **Not now**. "Not now" leaves the banner in place.

**Confirmation.** Before any write:
- Tesla's current plan beside the plan to send: seasons, windows, buy and sell prices. Reuse
  the selection review's comparison layout.
- Source label. For a public utility plan add: "These rates are estimated from public utility
  rates. Tesla will use them as shown."
- The effect: "Your Powerwall will start scheduling against these prices. You can change this
  in the Tesla app at any time."
- One confirm button. Cancel changes nothing.

**Result.**
- **Confirmed:** "Tesla now has this plan." The banner clears.
- **Sent, not confirmed yet:** "Sent to Tesla. It hasn't confirmed yet; PWUsage will check
  again." The next import settles it (banner clears, or stays if Tesla did not take it).
- **Rejected / failed:** say what Tesla said in plain words (not allowed, plan invalid, Tesla
  unavailable) and that nothing changed on the Powerwall.
- **Not allowed** (the person's Tesla sign-in lacks command rights or the `energy_cmds`
  scope): explain and offer the existing Tesla re-consent path where scope is the cause.

## Approaches considered

1. **Send, then confirm before answering (chosen).** The server builds the payload, validates
   it, writes, and reads Tesla back for a bounded time before responding. More work, but the
   person sees a real outcome.
2. **Send and let the next import confirm.** Simpler, but no outcome at the moment of the press
   and the banner lingers. Rejected.
3. **Client builds and sends the payload.** Rejected: Tesla tokens live only on the server.

## How it works (server)

Two endpoints for the site, mirroring the selection preview/commit pattern:

**Preview** (read-only). Loads today's actual plan and the latest Tesla plan, runs the semantic
comparison, builds the payload and validates it. Returns the before/after for the confirmation,
the source, any validation problems, and a **fingerprint** over: the active selection's content
and range, the latest Tesla tariff id/content, and the payload. No Tesla write.

**Commit.** Takes the fingerprint. Under the site lock, recompute; on mismatch return a conflict
so the client shows a fresh confirmation. Then, *outside* the lock (no network calls while
holding it, per the selection design):

1. **Build the payload** starting from Tesla's current `tariff_content_v2` (freshly read, not
   the stored copy), so fields PWUsage does not model (daily charges, demand charges, utility
   metadata) are kept. Replace seasons, energy charges and the sell tariff with today's plan,
   and set the plan name. Use Tesla's period labels (`ON_PEAK`, `OFF_PEAK`, `PARTIAL_PEAK`,
   `SUPER_OFF_PEAK`), since the Tesla app only displays those. Keep up to five decimals.
2. **Validate against Tesla's rules** before writing: seasons cover every day of the year with
   no overlap; each season's periods cover every hour of every weekday and weekend day with no
   overlap; every priced period has windows and every window has a price; currency is USD, EUR
   or GBP. A plan that fails is not sent; the preview says what to fix.
   Tesla's own adjustments are **shown, not refused** (owner's decision, 2026-11-19): a buy
   price below its sell price is raised to the sell price, and a negative price is rounded to
   zero. The confirmation lists each one, for example "Tesla will store Peak buy as $0.12
   (raised to match the $0.12 export rate)." PWUsage's own plan is not changed.
3. **Write** with `TeslaClient.setTimeOfUseSettings` using **the pressing user's own Tesla
   token** for their `energy_site_id` (IDs differ per invited account), so Tesla enforces who
   may change the device.
4. **Read back** `site_info` until the semantic comparison matches or about 20 seconds pass,
   staying well inside the 60-second function cap.
5. **Record the result** (see Storage) and, on a confirmed match, import the read-back plan
   through the normal Tesla import path so `latestTesla` is current and the banner clears.

**Duplicate presses.** A second commit with the same fingerprint while one is in flight returns
the in-flight attempt's status rather than writing twice.

**Mapping PWUsage's plan to Tesla's shape.** PWUsage plans already use Tesla's shape
(`TariffSeasonInput` in `tariff-contract.ts`): seasons with weekday and weekend windows, each
labelled with one of Tesla's four period names, with one buy and one sell rate. Public plans
have their tiers blended when they are saved. The mapping is therefore direct: season to
season, window to `tou_periods`, rates to `energy_charges` and `sell_tariff` by label. Tesla
prices a *label* per season rather than a window, so two windows in one season that share a
label but have different rates cannot be represented. Validation rejects that case and names
the season and label (*builder's call*). Season `fromDay`/`toDay` are sent as stored.

**Tesla-side preconditions** (*builder's call*). Sync is unavailable, with a plain reason, when
the site is not time-of-use capable or Tesla holds no `tariff_content_v2` to build on. Preview
reads Tesla fresh. That fresh content, not the stored `latestTesla`, is shown as "Tesla's current
plan" and covered by the fingerprint, and commit re-reads it before writing.

**Shared sites** (*builder's call*). The comparison uses the site's latest imported Tesla plan,
as the banner does today. Any member signed in with Tesla sees the button. The write uses that
member's own token and `energy_site_id`, and Tesla's refusal becomes the "not allowed" result.
The fingerprint does not depend on the user.

**Comparison tolerance** (*builder's call*). Rates compare after rounding to five decimals.
The comparison applies Tesla's two adjustments to PWUsage's side first. Without that, a plan
Tesla adjusted would never read as a match: the result would stay `unconfirmed` and the
banner and button would keep coming back.

## Effect on the timeline

A confirmed sync changes nothing about which plan PWUsage uses or its dates. The active
selection stays as it is; it is still the person's explicit choice. The read-back plan is
recorded as the latest Tesla version through the normal import, which already skips protected
spans, so no effective period moves and no reattribution runs. Prices are unchanged in any case.

## Restore and the Tesla original

The selection flow already saves the Tesla plan an override replaced, so Restore Original Tesla
Rate Plan can find it. An import of our own upload must never replace that saved original. It
is recorded as the latest Tesla plan only. If someone later restores the original in PWUsage,
the plans differ again and the same Sync to Tesla button sends the original back. No special
case is needed.

## Storage

A record per attempt: site, user, time, the selection and content sent, the Tesla tariff it
replaced, Tesla's response, and the outcome (`confirmed`, `unconfirmed`, `rejected`, `failed`).
`unconfirmed` attempts are settled by the next import's semantic comparison. Exact schema is
left to the builder.

## Contract

Additive fields on the timeline response, mirrored in `MobileLiveContract.swift` /
`mobile-dashboard-contract.ts` where they live (same PR, per `AGENTS.md`): whether a sync is
available, and the latest attempt's status and time. iOS is in beta with no old-build
compatibility requirement.

## Copy

Follow `docs/voice-and-terms.md`. The button label is **Sync to Tesla**.

## Testing

- Semantic comparison: identical content with different hashes/names/extra fields matches;
  changed window, price, season boundary or currency does not.
- Payload: preserves unmodeled Tesla fields; labels; five decimals.
- Validation: each Tesla rule, with a plan from Tesla, a manual plan and a public plan; buy-below-sell and negative rates appear as listed adjustments and still read as a match after the write.
- Commit: fingerprint conflict, duplicate press, scope/permission rejection, Tesla error,
  read-back timeout → `unconfirmed`, later import settles it.
- Import of our upload does not replace the saved Tesla original.
- Live check on one Dev-linked site (Harrison), then restore, as the probe did.

## Left to the builder

Schema and endpoint names; the exact Tesla error-to-copy mapping; read-back polling interval;
where the semantic comparison lives (shared by banner and sync). Also whether the probe script
and `tesla-tou-probe.ts` stay as a debugging tool or are folded in.
