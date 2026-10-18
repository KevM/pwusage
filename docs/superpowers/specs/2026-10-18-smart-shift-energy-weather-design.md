# Smart Shift: verdict, cost bars and energy weather

Date: 2026-10-18 · Builds on PR #157 (one selected Job card) · iOS app (`cmd/ios-app`)

## Why

Smart Shift is hard to understand. On a real device it showed three competing answers in the wrong order:

1. a large "Estimated $5.27 to start now", which reads like the advice but is the worse option,
2. "No saved job fits your export cushion", which reads like "don't run anything", and
3. the real answer, "Waiting could save $1.89, start at 4:30 PM", third and below the fold.

The same dollar figures repeated three times, and the screen used jargon ("export cushion", "projected bill", "grid rate"). It never said *why* a later start was cheaper, and "About 0.0 kWh of this run could come from your solar" sat under a "Solar forecast" heading, contradicting the obvious guess. The owner and a less technical tester both had no mental model of what the screen computes.

The goal is a screen that answers one question at a glance, *when should I run this job and what does that save me*, and that shows enough of the model for people to trust the answer.

## The model being explained (unchanged)

The calculation stays as it is. The redesign explains it:

- The utility nets imports against exports **separately for each rate period** across the billing cycle. Each period has a signed balance: positive is energy **banked** (exported and not yet used back), negative is energy **owed**.
- A Job is an amount of energy over a duration (cars: from their charge settings).
- Running a Job draws on the balance of each rate period it runs through. Energy covered by a positive balance costs only the credit given up (sell rate). The rest is bought at the buy rate. The sum is what the Job adds to the bill.
- With a solar forecast (Solcast plus the 14-day household profile), balances are projected forward and each start time is priced; the cheapest is compared with starting now.

## Goals

- One verdict sentence that names the Job and the time: *"Charge the car at 4:30 PM: about $1.89 cheaper than now."*
- A cost comparison that people read correctly at a glance, where shorter means cheaper.
- A chart, the "energy weather", that shows *why*: which bank each option spends.
- It works without Solcast, and invites people to connect Solcast.
- Plain language, with one word for the concept ("bank": banked / owed).

## Non-goals

- No change to the cost model, tariff handling, or the Solcast/household-profile pipeline.
- No change to Battery Hold or other Smart Shift toolbar items.
- No new server routes.

## Anti-goals (failures even if it technically works)

- **"Bigger looks better" misreads.** The tester read a higher Off-Peak line as the better outcome. kWh lanes alone must never be the only comparison; dollars come first.
- A chart that implies charging *helps* a bank. The previous mock drew only the recommended plan, so the Peak line rose on solar and looked like the car's effect.
- Showing history the decision doesn't need. The chart starts at now.
- A Gantt-style run bar under the chart. It was tried and confused the owner, so don't add one.
- Repeating the same figure in several places.
- Forecast-free lanes that drain from typical household use. On a sunny day that would look wrong and push people away from good start times.

## The screen, top to bottom (decided)

Reference mockups (HTML fragments from the brainstorming session, rendered inside the companion's frame): `assets/2026-10-18-smart-shift-forecast-mockup.html` (card **X**) and `assets/2026-10-18-smart-shift-no-forecast-mockup.html` (left card).

1. **Verdict** (headline): `<Job name> at <time>: about <$ saving> cheaper than now`, or `<Job name> now: no cheaper time today` when starting now is cheapest. Job names are already verb phrases (see Naming), so no "Run"/"Charge" prefix.
2. **Cost bars**, captioned "Added to your bill (shorter is better)":
   - *Charge later* (emphasized, blue, bold label) and *Charge now* (muted), each with its dollar amount.
   - The empty space after the shorter bar is outlined and labelled with the percent difference, e.g. "36% less", computed as `(now − later) / now`. Omit the label if it doesn't fit.
   - When starting now is cheapest: a single bar, caption "Added to your bill".
3. **Why line**, one sentence in plain words, e.g. *"Charging now runs during Peak, where you have no bank. Run at 4:30 PM to use your Off-Peak bank."* It names the periods involved and whether each is banked or owed.
4. **Legend**: "Charge later" (thick solid) and "Charge now" (thin, faint, dashed). The legend uses the Job's verb. These labels are for a car; another Job would read "Wash the dishes later", say. Wording is left to the builder within that pattern.
5. **Energy weather chart**: one lane per rate period that the compared runs touch, titled "<Period> bank (kWh)".
   - The x-axis starts at **now** and ends at the forecast horizon. Each lane has its own axis with real clock times: now, rate-period switches, and run end times.
   - A dashed vertical line marks each rate-period switch, labelled "← Peak | Off-Peak →" (or the actual period names).
   - Background: green above zero ("banked"), orange below ("owed"), with a zero line.
   - Two lines per lane: the later start (thick, solid, blue) and starting now (thin, dashed, faint). Each ends in its value ("+10", "−9"). If they end at the same value, show one label.
   - With a forecast, lines include projected solar and household use. Without one, they are flat except for the Job's own draw.
6. **Without a forecast only**: a note under the chart: *"Without a solar forecast, banks are shown as they stand now. Connect Solcast to see today's solar."* "Connect Solcast" opens the existing Solar Forecast Settings sheet. This is the onboarding route for Solcast.
7. **How this is worked out ›** opens one details view. It merges today's "Energy Details" and "Forecast Details": per-period rates, kWh drawn from each bank or bought, forecast and household-profile freshness, and the assumptions note.
8. **Try another job ›** stays as a row (the PR #157 picker).

### Removed from the card

- The "Estimated $X to start now" headline (now the Charge now bar).
- "No saved job fits your export cushion" and the "fits surplus" ranking language. Each Job gets its own verdict, so the "largest Job that fits" ranking isn't shown on this card.
- Duplicate dollar lines ("adds $X to your projected bill" twice) and "Estimated savings".
- "About N kWh of this run could come from your solar" on the card. It may live in the details view.

## Forecast-free start-time comparison (new behavior)

Today the basic layer only prices *starting now*. Without a forecast, the screen must still compare start times. Price each candidate start with the same per-period bank arithmetic as `LoadTimingEstimator.estimateStartNow`, holding each period's balance at today's observed cycle balance, with no solar and no household projection. The search horizon is the same one the forecast path uses. Pick the cheapest start; ties go to the earliest.

## Edge states (decided)

- **Starting now is cheapest**: "<Job> now: no cheaper time today", one cost bar, one line per lane. Lanes the run doesn't touch still render (flat) so people can see it doesn't draw on them.
- **Data that can't be trusted** (stale observations, incomplete rate plan, missing balances, or a run that crosses the billing-cycle boundary): no verdict, bars or chart. Instead, one short plain sentence saying why and what to do. Keep today's distinctions, including the PR #157 fix that names which Job crosses the billing cycle.
- **No Jobs**: unchanged ("Add a Job").

### Solcast connected but the forecast comparison can't run (my call)

The forecast can be loading, waiting for arrays, out of requests for the day, short of household history, too old, or rejected. In all of these the card shows the **forecast-free** verdict, bars and flat lanes. The "Connect Solcast" note is replaced by the existing specific note from `LoadTimingForecastPresentation.note` for that state, shortened to one sentence. While loading, the forecast-free version shows with "Checking today's solar…". It switches to the forecast version when the forecast arrives, with no animation of the verdict text.

### Trust gates (my call)

Keep today's thresholds per path:

- The forecast-free comparison follows `LoadTimingRecommendation`: observations up to 60 minutes old, and a failed refresh counts as stale.
- The forecast comparison keeps `maximumBalanceAge` (30 minutes). When it fails only that gate, the card falls back to the forecast-free version rather than hiding.

A missing balance for a period does not hide the card. That period is priced at the buy rate, as `estimateStartNow` does today, and a one-line note says so. Only stale observations, a missing or incomplete rate plan, and a billing-cycle crossing hide the verdict, bars and chart.

## Naming (decided)

Jobs are named "Verb the noun": *Charge the car*, *Wash the dishes*, *Bake bread*. The UI uses the name as-is, so `LoadTimingPresentation.actionTitle` and `explorationTitle` stop adding "Run"/"Charge" prefixes.

Built-in renames are my call (adjust freely): Car → *Charge the car*, Dishwasher → *Wash the dishes*, Washer → *Wash the laundry*, Dryer → *Dry the laundry*, Washer–Dryer Combo → *Wash and dry the laundry*. The custom Job's example name and the editor's name placeholder become *Bake bread*. Existing installs must pick up the new built-in names unless the person has renamed a built-in Job (built-ins currently can't be renamed, so in practice: always). Custom Job names are never rewritten. The one exception: the seeded example custom Job (`custom-example`) is renamed to *Bake bread* only while it still has its seeded name "Custom" (my call).

## Constraints

- iOS 18 SwiftUI; follow the existing `SectionTheme` and dark-mode conventions. The mockups' colors are illustrative.
- Solcast calls are budgeted (10/day); the redesign must not add requests.
- The chart is computed on device from data the screen already has: bill response, tariff timeline, cycle balances, Solcast batch, planning context. No new server work.
- Accessibility: the verdict, bars and lane end values need VoiceOver text. The chart needs an accessibility summary ("Off-Peak bank: 18 kWh banked now; charging later leaves 5, charging now leaves 18…").
- Keep the minute-tick and frozen-forecast behavior from PR #157: the overlay is computed once per body pass and is never re-run on every tick.

## Left to the builder

- Chart implementation (Swift Charts is the natural fit), exact colors, sizes, and the threshold for hiding the % label.
- How many lanes to show when a tariff has more than two periods. Default: only periods the compared runs touch, plus the period in effect now.
- Exact why-line templates for the period combinations a tariff can produce.
- Structure of the details view.
- How the per-lane time series are derived from the existing estimator internals, including exposing intermediate balances from `LoadTimingForecastEstimator`.
- The migration mechanism for built-in Job names.
