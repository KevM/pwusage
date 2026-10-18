# Smart Shift: project rate-period banks to the bill date

Date: 2026-10-18 · Builds on the Smart Shift energy weather redesign (`2026-10-18-smart-shift-energy-weather-design.md`, branch `claude/smart-shift-energy-weather-5de814`) · iOS app (`cmd/ios-app`) and server (`cmd/next-app`)

## Why

Smart Shift prices a Job against where each rate period's bank ends up. Today it can only see as far as midnight tomorrow, so it ignores everything that happens to the banks between then and the bill date.

The owner's real case (Harrison, We Energies, Sunday 2026-10-18):

- Off-Peak is owed (−64 kWh). Weekday On-Peak (08:00–20:00) has +5 kWh banked.
- A sunny Monday is forecast to lift On-Peak to about +33.
- The car needs 52.7 kWh. Smart Shift says "tomorrow at 4:30 PM, $3.38". It puts 31.5 kWh into On-Peak (4¢ credit) and buys 21.2 kWh in Off-Peak (10¢) after 20:00. It refuses to put the whole charge into On-Peak, because by tomorrow night that would overdraw On-Peak and be priced at 31¢.

But the bill only cares about the bank on the **bill date** (about Nov 10), and roughly 16 more weekdays of On-Peak solar arrive before then. When On-Peak will end the cycle banked anyway, the whole charge could go into On-Peak for 52.7 × 4¢ = $2.11.

The owner already makes this call by hand in PWUsage:

1. Look at the On-Peak bank.
2. Guess how long the car can charge before going into deficit.
3. If the next few days look sunny and the bill date isn't close, go ahead and dip into deficit.

It is exhausting, and without the app they would play it safe at Off-Peak for fear of the 31¢ rate. Smart Shift should make that call for them, with enough caution that they'd act on it.

## The model (changes from the energy weather design)

The cost model is unchanged: each period nets separately across the cycle, a banked kWh costs its sell rate, and an owed kWh costs its buy rate. This is the same netting as `priceBillUsage`. What changes is how far balances are projected, and what decides that a start is safe.

### Two horizons

- **Search window:** candidate start times run from now to midnight tomorrow. The card only ever suggests today or tomorrow. *(My call:)* a run must **start** inside the window but may **finish** after midnight tomorrow; it must still finish by the bill date (the existing billing-cycle crossing block is unchanged). The chart shows only the part of a run inside its window.
- **Projection horizon (new):** balances are projected to the **bill date** (`currentBill.cycleEnd`). Each start is priced by the change it makes to the bill at the bill date.

### Where each part of the projection comes from

- **Forecast window:** from now to `min(now + 7 days, bill date, end of forecast coverage)`. Solar comes from Solcast's `pv_estimate` (median). Home load and battery come from the existing household pattern (14-day median per half-hour slot), as today.
- **After the forecast window, to the bill date:** use the site's history of **grid flow** per half-hour slot. Each future half-hour gets that slot's typical grid net export, assigned to its rate period through the tariff timeline. The phone does this reckoning itself; the server does not compute per-period changes.
- **Without Solcast** (not connected, loading, or unusable): use history for the whole projection, from now to the bill date. This replaces "banks held at today's values". Only if history is insufficient (the existing "at least 5 usable days" rule) does the projection fall back to holding banks flat.

### Typical and cautious

Each projection is run twice:

- **Typical:** Solcast `pv_estimate` inside the forecast window, then the history median per slot. This is what prices every start.
- **Cautious:** Solcast `pv_estimate10` inside the forecast window, then a **dull-ish day from history**, about 1 in 4. Home and battery use the same median pattern in both runs.
  - *(My call, revising "25th percentile per slot":)* the cautious history day is a real day, not a per-slot percentile. Adding up separate 25th percentiles for every half-hour of a week is far gloomier than "1 in 4", and would rule out almost every bank-drawing start. The server ranks the usable days by their whole-day grid net export and sends the mean slot profile of the days in the 20th–30th percentile band (at least one day). The phone still does the rate-period reckoning itself. The owner weighed the alternatives and accepted this one: per-slot percentiles are too timid, ranking per rate period would move tariff reckoning to the server, and a 1-in-4 *week* fits the cloudy-week rule best but needs more history than 28 days. Revisit the week version once backfill brings months of history.
  - *(Revised 2026-10-18 after a device test, decided by the owner:)* repeating the dull day on every day of the safety window made the cautious run a week of dull days in a row. At Harrison in October that left On-Peak about 20 kWh short before any charge, so no On-Peak start could ever pass. The phone now approximates a 1-in-4 *week* from the same data: each history slot moves 1/√7 of the way from typical toward the dull day (the shortfall of a week of roughly independent days grows with √7, not 7). The server still sends the dull day unchanged.
- **Short forecast coverage** *(my call):* where Solcast covers less than the forecast window (an older cached batch, or a fetch from hours ago), history fills the gap: typical history in the typical run, the cautious day in the cautious run. The safety window never shrinks to the forecast's end.
- **Rate changes before the bill date** *(my call):* keep today's rule that the projection ends at the first change of a period's rate (a season boundary, say) or the first period with no balance. When that happens before the bill date, prices and the bank note use that date ("projecting +40 by Nov 1, when rates change"), and the safety window ends no later than it. Projecting across a season change is left for later.

### The safety rule

A start that draws on a bank is only eligible if, under the **cautious** projection with that start, that bank is no worse than **−3 kWh** at the end of the **safety window**. The safety window ends at `min(now + 7 days, bill date)`. With Solcast, that is the end of the forecast window. Without Solcast it is the same 7 days, projected from history.

- "Draws on a bank" means the typical projection prices some of the run's energy in that period at its sell rate. Periods the run buys outright, such as an Off-Peak that is owed anyway, are not checked: they are already priced at the full rate.
- History after the safety window can carry a bank back up in the typical projection that sets the price. It can never be what makes a start pass the safety rule.
- The rule applies to **every** start, including starting now (decided by the owner). On a weekday morning in On-Peak, "now" may be cheapest because it spends the bank, yet still fail the rule.
- The recommendation is the **cheapest start that passes** (decided by the owner), even when it costs more than starting now.
- *(My call:)* if no start passes, recommend the start whose cautious shortfall is smallest (ties: cheapest, then earliest), and say plainly that every option risks a shortfall.
- The owner accepts misses of 1–3 kWh because later days can course-correct. More than that is a failure.

Among eligible starts, the cheapest wins and ties go to the earliest, as today. The minor-unit savings threshold applies when comparing a passing later start with a passing "now".

## What the phone needs (data)

1. **Solcast:** request 7 days explicitly (`hours=168`) on the existing call. Keep `pv_estimate10` alongside `pv_estimate` for each interval in the stored batch. A cached batch without it (stored by an older build) uses the median for the cautious run too, until the next fetch. **No additional requests:** the 10-a-day budget is unchanged.
2. **Household pattern** (`GET /api/mobile/load-planning-context`): add to each half-hour slot:
   - grid net export, as typical (median across days) and cautious (the mean of the 1-in-4 dull days described above);
   - solar, as typical (median).
   
   These come from the **last 28 days** of history: per slot, take each day's mean over that half-hour, then the percentile across days. Use the same day-quality rules as today: drop a day without enough coverage, and require at least 5 usable days. Existing `homeKw` / `batteryNetChargeKw` stay as they are (14 days). The change is additive: an app talking to an older server simply has no history fields and behaves as today. Solar history is not used in the projection maths yet; it is there to compare Solcast against what the roof actually did, and for the later projected-bill work.
3. **Tariff timeline** (`/api/mobile/bill-summary`): `tariffTimeline` currently ends 7 days out. It must reach the bill date (`cycleEnd`).

## On the card

- **Headline, bars, why line and lanes:** unchanged in form. The chart keeps showing now through midnight tomorrow; a cycle-length chart would be too squashed to read. Lane end labels are balances at the chart's right edge, not at the bill date.
- **When the safe start costs more than now:** the headline says so, e.g. "Charge the car tomorrow at 9:00 PM: about $0.80 more than now, but it won't leave On-Peak short." *(My call:)* both bars still show, the recommended one first; the caption drops "(shorter is better)" and there is no "% less" label. The why line names the bank that starting now would overdraw in a cloudy week.
- **"How this is worked out":** each start's block keeps its kWh × rate = $ lines. For each bank a start draws on, the note reads like **"On-Peak bank is +5 now, projecting +60 by Nov 10 (bill date), +7 after this charge."** Use the actual date. *(My call:)* show both the projection without the run and what's left after it, so the arithmetic above it adds up. The comparison carries both bill-date figures per lane, separately from the chart-edge values.
- **When a cheaper start was ruled out by the safety rule:** say so in the details, in one line. For example: "Charging all in On-Peak would be cheaper if the sun holds, but a cloudy week could leave On-Peak more than 3 kWh short by Oct 25, so it isn't suggested."
- **The why line** should stay truthful when the bank it uses is filled by projected solar across later days rather than tomorrow alone. The current wording "On-Peak energy your solar banks before then" no longer fits; the builder words it within the existing pattern.
- **Without Solcast:** the note under the chart changes from "Without a solar forecast, banks are shown as they stand now. Connect Solcast to see today's solar." to wording that matches the new behavior, e.g. "Without a solar forecast, banks follow your last four weeks. Connect Solcast to see this week's solar." The Connect Solcast button stays.
- **Assumptions list:** state the projection sources and horizons in plain words: Solcast for 7 days, the last four weeks after that, through the bill date.

## Goals

- Recommendations that reflect the whole billing cycle, so a bank that will recover by the bill date can be used now.
- Caution the owner trusts: a start that dips into a bank must survive a cloudy forecast week within 3 kWh.
- The best data available is always used: Solcast when present, the site's own history otherwise.

## Non-goals

- Projected-bill views over 14 days using the conservative estimate. That is a separate later PR (the solar history added here is meant to feed it).
- Weekday/weekend (or day-of-week) splits of the history. The owner's household is home all the time, and four weeks hold only about 8 weekend days. Add a split later only if the history shows it changes recommendations.
- Blending last year's same weeks for seasonality.
- History backfill and per-slot rollups (decided by the owner; part of the rollup-storage migration work). This change works from whatever raw history a site already has; raw 5-minute data is kept 365 days by default, so the 28-day read is covered. A new or patchy site gets flat banks (fewer than 5 usable days) or a noisier "dull day" until history fills in. Backfill still has to be fully enabled, and it will make this projection good for every site; it comes in later PRs.
- Suggesting start times beyond tomorrow.
- Any change to the cost model or to `priceBillUsage`.

## Anti-goals

- A suggestion that leaves a bank more than about 3 kWh short when the forecast week turns out cloudy.
- Letting history beyond the forecast window be the reason a start passes the safety rule.
- Extra Solcast requests.
- Silently changing the chart's meaning. If lane end values aren't bill-date values, nothing on the card may imply they are.

## Constraints

- Keep PR #157's frozen-forecast behavior: the comparison is computed once per body pass, never on the minute tick. The cautious run roughly doubles the per-pass estimator work, so keep the cost in the range already measured (about 6 ms flat and 37 ms forecast for six Jobs on the simulator), or make it cheaper.
- Server: measure the Supabase database read of the 28-day household pattern on the Dev DB (socket byte count) before shipping, per the egress practice used for crons. Prefer reading from existing compact or rollup data if it gives the same per-slot values.
- Compatibility: the app must work against a server without the new fields, and the server must not break older app builds (additive fields only).
- iOS 18 SwiftUI, Swift Testing, TDD as on the energy weather branch.

## Left to the builder

- How the estimator represents the two projection stages and the cautious run, provided the existing `LoadTimingForecastEstimatorTests` keep passing (adjusting only those that encode the end-of-tomorrow pricing horizon, with each change justified).
- Payload field names and shapes for the new slot values, and whether the history window is a constant or a server setting.
- How history slots map onto days with DST changes (follow the existing local-minute slot mapping).
- Exact copy for the why line, the ruled-out line and the assumptions, within the patterns above.
- Whether the forecast window ends exactly at `now + 7 days` or at the last full forecast half-hour.
