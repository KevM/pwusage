# Smart Shift: a glanceable screen

**Date:** 2026-11-05, updated 2026-11-06
**Scope:** iOS app, Smart Shift tab only
**Prototype:** [`assets/2026-11-05-smart-shift-glanceable-prototype.html`](./assets/2026-11-05-smart-shift-glanceable-prototype.html)
(the agreed look and motion, as an unwrapped page fragment; the car numbers are demo values, and the dishwasher
and "Now is best" cases are made up)

## Why

The owner opens this tab to learn what charging the car right now would do. It also serves other jobs. In the
owner's order:

1. **Main goal:** communicate the best time to run the job.
2. **Secondary goal:** help the person understand why waiting, or not waiting, is better.

Today's headline does the first well, but it is long and followed at once by a caption, a paragraph, a legend and
two time-series charts. The owner found this overwhelming, including when reduced to one time-series chart.

Two findings shaped the design. A non-technical person shown an earlier version could not tell which rate to try
to get to zero. And the owner felt people wouldn't know where the bars should ideally go. So the bars have to show
good and bad placement themselves, without more text.

The Bill tab recently had a similar pass (#307), and this should feel like its sibling.

## The screen

From top to bottom, inside the existing job card.

### Headline, split in two

- Line 1, bold: `Charge the car at 7:33 PM`
- Line 2, emphasis color, semibold: `About $5.04 cheaper than now`

Keep the existing wording rules for the job's name and for "tomorrow at".

### Two choice tiles

Side by side, in the style of the Bill tab's pair of totals, recommended first. Each is a button.

| Tile | Label | Price | Caption |
| --- | --- | --- | --- |
| Recommended | `At 7:33 PM` | `$4.00` | `All Off-peak` |
| Start now | `Now` | `$9.04` | `Mostly On-peak` |

The selection is one outline and tint that slides between the tiles, rather than a style on each tile. The price is
what the run adds to the bill, the same value the cost bars show today. Selecting a tile changes only what is shown.
Nothing starts.

### One bar chart that responds to the selected tile

Section title `Distance to net zero`, with `kWh by Nov 15` beneath it. The date follows the existing projection end
rule: bill date, or the rate-change date when the projection stops there (see `projectionEndPhrase`).

- One vertical bar per rate period, **highest buy rate first**, left to right. Under each bar: period name and buy rate.
- A zero line. Owed rises above it and banked falls below it, matching the Bill tab, where up means more cost.
- Each bar has two parts:
  - **Gray:** the bank without this run. It doesn't change with the selection.
  - **Emphasis color:** this run, labelled `+24`. A run always moves a bar upward, toward owed. The block spans from the
    gray's end to the total, drawn over the gray. So a run that uses part of a bank sits inside the gray, and one that
    uses all of it crosses the zero line (bank 10, run 24: the block spans 10 below zero to 14 above it).
- Above an owed bar, or below a banked one, is its total: `86 owed` or `12 banked`. The total's sign decides the side.
  The badge stays centered on the block's end of the bar.
- The scale stays fixed across both selections, so only the run moves.
- There is no time axis, rate strip, switch line, legend or second series.

### Badges, labels and the slot

These replace written guidance on where the energy should go.

| Selected | Badge | Label under the bar | Slot |
| --- | --- | --- | --- |
| Recommended | Green check on the run's block in the cheapest place | `Least expensive` under that bar | None |
| Now, when waiting saves money | Red mark on the run's block at the highest rate | `Most expensive` under that bar | Green dashed slot on the recommended bar |

So only one label shows at a time: it moves with the selection and explains the badge.

**The slot** reads `Save $5.04` and is a button. It shows only at Now, and only when `claimsSaving` is true, so it
doesn't depend on the red mark: a saving with no red mark still gets a slot.

- **Which bar:** the one where the recommended run adds the most energy compared with starting now. If two tie, the
  one with the lower cost per kWh. If no bar gains energy, there is no slot.
- **Where:** directly above the Now total on that bar, including when that bar is banked, because the block grows up
  into it on the return.
- **Height:** that extra energy, with a minimum of 22 pt so the saving stays readable on small jobs.

### Tapping

- **A tile:** quick and settling, about 0.6 s, fast first. Bars and numbers animate to that choice.
- **The slot:** returns to the recommended tile, deliberately **slow then fast**, so the person sees that their
  selection is being moved back to our suggestion:
  1. Over about 1.15 s with an ease-in curve, the selection outline slides back, the blue blocks move and the numbers
     count, all together. The prototype uses `cubic-bezier(.6,.02,.8,.25)`.
  2. The slot holds still while the Off-peak block grows into it. The red mark fades at the start.
  3. On landing, the slot goes, `Most expensive` changes to `Least expensive`, and the suggested tile and the check
     give one small pop.

The slot is disabled during the return.

### Below the chart

Keep as they are today: the notes (no forecast, forecast state, automatic forecast with its settings button, unobserved
balance), `How this is worked out`, `Try another job` and the better-job hint, the solar invitation card and the footer
metadata.

## What goes away

- The caption "Added to your bill (shorter is better)".
- The cost bars and their "% less" label.
- The paragraph explaining why, which moves to the top of `How this is worked out`. Nothing else in that sheet changes.
- The legend, both time-series charts, the switch labels and their layout code.

## Where the numbers come from

Use the lane values already computed for the projection end, the same basis the cost is priced on:

- Gray: `BalanceLane.projectedKwh`
- Total if recommended: `projectedAfterRecommendedKwh`
- Total if now: `projectedAfterStartNowKwh`
- The run's block: the difference between gray and total
- The slot's saving: `comparison.savings`, the same value as the headline

Banks in the model are positive when banked, so plot them through `EnergyBalanceAxis`, and word the labels as
`balanceLabel`/`endLabel` do.

**Check while building:** in the demo, both runs agree on the same gray values, and the energy times the rates equals
the prices (24 kWh × 31¢ + 16 kWh × 10¢ = $9.04; 40 kWh × 10¢ = $4.00). I expect this to always hold, but it has only
been confirmed on this case, so add tests, including a run that draws on a bank. Tile prices must keep coming from
the comparison, not this arithmetic.

## Other states

- **Now is the recommendation:** one non-interactive `Now` tile. Line 1 `Charge the car now`, line 2 `No cheaper time
  today`. A green check and `Least expensive` when the run is in the cheapest place. No slot and no red mark. The
  prototype shows this.
- **The safe start costs more than now (`nowUnsafe`):** both tiles, recommended first. Line 2 keeps the warning, in the
  existing words: `About $0.80 more than now, but it won't leave On-peak short`. No badges, labels or slot, because
  "cheapest" and "save" would be false here.
- **No start is safe (`noSafeStart`):** the same, with line 2 `The least risky time, but a cloudy week could still leave
  On-peak short`.
- **A safe start that is also cheaper than now:** treat it as the normal saving case, as the headline does today
  (`claimsSaving`).
- **Blocked, loading and no-jobs states:** unchanged.

## Decisions

The owner decided:

- Tiles select the choice, and the chart shows one choice at a time.
- Bars of the rate periods, showing distance from net zero in kWh, not dollars. Dollar bars were rejected because they
  repeat the price and their labels confused.
- The green check on the promoted block, a red glyph on the block added to the most expensive rate, and the label that
  moves between `Most expensive` and `Least expensive`.
- The tappable slot that shows the saving, because it makes the screen tactile and adds value. No arrow.
- The slot's slow-then-fast return, so people notice their selection going back to our suggestion.

My calls, which the owner has seen in the prototype but not separately approved:

- The gray and blue split in each bar, and the fixed scale.
- The sliding outline, the block filling the slot, and the landing pop.
- The 22 pt slot minimum. A block too thin for its label shows it beside the bar (`+3`).
- Removing the line `Get On-peak to zero first`, because the badges now carry that message.
- At Now, the +16 already in the cheapest place stays unbadged, so the only mark is the problem.

My calls that the prototype does not show:

- The screen opens on the recommended tile. It resets when the job changes, when a refresh removes the selected option,
  and when the tab is opened again. The selection is view state and is not saved.
- The caption rule: `All <period>` at 95% or more of the run's kWh, matching the existing "mostly" threshold; otherwise
  `Mostly <period>` for the largest share; if none has over half, the two largest: `On-peak and Off-peak`.
- **Where badges go.** "Cheapest" means what this run actually pays per kWh in that period, blended: the export credit
  given up for energy from a bank, and the buy rate for the rest. So 5 kWh from a bank at a 4¢ credit plus 3 kWh bought at
  10¢ costs about 6¢ per kWh.
  - The check goes on the recommended run's largest block, when that block's cost per kWh is the lowest of the run's
    blocks **and** at least one other rate period's price is strictly higher. Other periods are compared at their buy
    rate. A single-period plan, or periods at equal prices, gets no check, because there's nothing to be cheapest
    against. This also applies to "Now is the recommendation".
  - The red mark goes on the Now run's block with the highest cost per kWh, when that cost is above the recommended
    run's average.
  - Middle-priced periods get no badge. Without a clear winner, show no badge.
- **Where a label could mislead.** Energy from a bank can be cheaper than the lowest buy rate, so a check could land on
  a bar showing a higher buy rate. In that case, show the check without `Least expensive`.
- The rate under each bar is the buy rate, even for a banked bar. Equal buy rates keep the existing tariff order.
- "Net zero" is a new on-screen Smart Shift term, so add it to `docs/voice-and-terms.md`.

## Open questions for the owner

Neither blocks a plan, and the defaults below apply unless the owner changes them.

- **`Save $5.04` wording.** The voice guide says to say "about" and never promise a saving, but `Save about $5.04` barely
  fits in the slot. Default: `Save $5.04`, with "about" in the headline and VoiceOver, plus a note in the voice guide.
- **Red or orange.** The iOS guide allows only Cerulean for emphasis, and green and orange are already chart colors.
  Default: red as the owner described, treated as a status color and recorded in `cmd/ios-app/AGENTS.md`.

## Accessibility and adaptability

- **Reduce Motion:** tiles and the slot change by crossfade, with no slide, growth or pop. The slower return is what
  explains the change, so the crossfade must still clearly land on the recommended tile.
- **VoiceOver:**
  - Tiles are buttons with the selected trait.
  - The slot is a button labelled like "Save about $5.04 by starting at 7:33 PM". After it's used, announce the move
    to the recommended time and the new totals.
  - Badges have words, such as "Least expensive", so nothing relies on color.
  - The chart is one element, summarised for the current selection, highest rate first.
- At accessibility text sizes, the tiles stack and no text may overlap. If `Save $5.04` can't fit in the slot, it may
  grow or move beside the bar, but it stays a tappable target of at least 44 pt.
- Plans with three or more periods must fit at phone width. On wide screens, the chart must not stretch into an
  unreadable width.
- Use `Color.emphasis` for the run and selection. Check light and dark mode, including badges, slot and labels.

## Goals

- From a cold open, someone can tell the best time and what it saves in a couple of seconds.
- Someone new can tell whether the energy is in a good place, and where it should go, without reading a sentence.
- A person who taps the slot notices that the selection went back to the suggestion.
- Labels never collide, at any supported size or data shape.

## Non-goals

- No changes to the estimator, recommendation or safety rules, API or contract, Bill tab, Home tile, widgets or web app.
- No change to how jobs are managed or chosen.
- No "start this job" action.

## Anti-goals

These would make this a failure even if it worked:

- Another wall of text, or an explanation paragraph back on the main screen.
- Both choices on the chart at once.
- A second set of dollar figures competing with the tile prices. The slot's saving is the same figure as the headline.
- Rate labels on the chart, with "On-peak" meaning a time next to a bar where it means a bank.
- A check or `Save` that isn't true for this comparison.
- Hiding or softening a safety warning to save space.
- A selection change the person doesn't notice.
- Labels sitting on top of each other.

## Known limitation

Off-peak can be the tallest bar even though On-peak matters more: in the demo, 238 owed against 62. The badges and
highest-rate-first order address this. Check it with the same non-technical tester, since they found the earlier
version confusing, and on a device. Fading lower-rate bars was tried and left out.

## Left to the builder

- View structure and naming, including whether `SmartShiftVerdict` is reshaped or replaced. Keep display decisions in
  `SmartShiftPresentation` so they stay testable, including the badge rules.
- Which code and tests can be deleted. `EnergyWeatherChart.swift` also holds colors used by `BillOutlookChart.swift`,
  `BillEstimateDetails.swift` and `BillSavingsViews.swift`, so those need a new home first.
- The SwiftUI animation details, as long as the prototype's feel and order hold. The prototype's timings are a starting
  point, to be judged on a device.
- Whether to add a light haptic when the slot's return lands. It fits the owner's "tactile", but hasn't been shown.
- Whether to mirror `BillEstimateHeader` directly or share a smaller tile view.

Repository rules apply: see `cmd/ios-app/AGENTS.md`, including a failing test first, clean lint with
`./cmd/ios-app/lint.sh`, zero compiler warnings, and on-device checks with the worktree's Xcode command in the hand-off.
