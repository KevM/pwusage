# iOS Load Timing Polish Design

## Purpose

Make the native Load timing screen easier to scan and make the car estimate reflect a planned charge instead of a fixed vehicle size. This builds on PR #114 and changes no server contract or database schema.

## Period balance and rate language

- Rename **Observed this cycle** to **Your energy balance**, with **By rate period this billing cycle** as supporting text. The tiles continue to include only periods with recorded energy in the current billing cycle.
- Show USD unit rates in cents per kWh throughout the native dashboard and Load timing detail, matching the web card. Keep total load estimates in dollars. Preserve the existing currency format for non-USD sites rather than labeling another currency as US cents.
- Keep the existing surplus/deficit sign convention and accessible spoken rate labels.

## Compact load estimator

- Show Car, Laundry, Dishwasher, and Custom chips in a single horizontal row. The row may scroll horizontally at narrow widths and larger text sizes.
- Remove Big car and Little car. Selecting Car exposes compact battery capacity and current-charge controls, plus one slider labeled **Charge to**. Defaults are 60 kWh, 20%, and 80%. The estimated load is `capacityKwh * max(targetPercent - currentPercent, 0) / 100`; this excludes charging losses and should be labeled as an approximate energy-to-add estimate.
- Keep Laundry and Dishwasher at their existing kWh amounts. Custom uses a compact numeric amount control instead of a slider.
- Remove the graphical covered/bought bars beneath estimate rows. Keep the coverage quantities and verdict in text so no estimator information is lost and the target slider remains visually distinct.
- Tighten spacing in the estimator while retaining the current period ordering, rate, next-start cue, total estimate, verdict, and accessibility descriptions.

## States and verification

Existing no-tariff, no-cycle-data, stale-data, and unknown-pricing states remain. Car inputs must never produce a negative or non-finite load. Add focused Swift Testing coverage for the car calculation and currency formatting; run the native test script and review the affected SwiftUI previews. The Next.js app is unchanged.
