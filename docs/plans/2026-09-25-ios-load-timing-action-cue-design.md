# iOS Load Timing Action Cue Design

## Purpose

Replace the small “Now is the cheapest observed period” sentence at the top of the iOS Load timing detail with a prominent answer to what the current tariff period's cycle surplus can comfortably cover. The website's “Can run now” tile is the behavior reference; this change is iOS only.

## Data and decision

- Use the **observed active period** from `LoadTiming.periods`, not a synthetic unobserved entry from `pricingPeriods`. No active-period observation means the cue states that this period's balance is not recorded yet.
- Compare its export-positive `cycleNetExportKwh` with the existing headroom thresholds: Dishwasher 5 kWh, Laundry 20 kWh, and Car at 1.6 times the current configured Car charge. Exclude Car when its planned charge is zero. Choose the largest comfortably covered load.
- Show the next load above current headroom and how many additional kWh it needs, including a current deficit in the shortfall. If nothing is covered, use the website's cautionary **Avoid large loads** verdict. Never imply a load is free: the detailed estimator continues to show its monetary cost.
- When `LoadTiming.nextCheaper` exists, keep its period, marginal rate, and relative start time as a short separate line within the cue. The affordability verdict and cheaper-time advice both remain visible.

## Presentation

- Place a full-width, prominent **Can run now** panel before **Your energy balance**. Use a larger load name with an appropriate symbol or a caution icon, followed by a concise period and surplus/deficit line, then the next-load shortfall. The provided website screenshot is a visual reference for hierarchy, not a pixel copy.
- Retain **Load timing** as the screen title and **Can I run this now?** as the estimator heading. Remove the old inline cheapest-period sentence and avoid reintroducing **When to run a load**.
- Keep large text layouts readable and provide one clear VoiceOver description of the verdict, context, next step, and cheaper-time advice.

## Verification

Add focused Swift Testing coverage for boundary thresholds, dynamic Car size, active-period selection, deficit and no-observation states, and cheaper-time content. Run the full native suite and repository checks. No mobile API, website, or migration changes.
