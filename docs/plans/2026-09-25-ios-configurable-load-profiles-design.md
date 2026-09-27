# Configurable iOS load profiles and start-now estimates

## Goal and scope

Let the user keep useful load examples on the phone and estimate the cost of starting one now, including runs that cross tariff periods. This replaces the current per-period, whole-load hypothetical prices in the native Load timing detail. Profiles are shared across all sites on the device. No account storage, database migration, or website profile editor is needed.

## Profile experience

- Put a gear in the Load timing navigation bar. It opens a Load profiles sheet with built-in profiles and a Custom loads section.
- Built-ins are Car, Dishwasher, Washer, Dryer, and Washer–Dryer Combo. Each appliance has editable total energy (kWh) and duration. Preserve the current 5 kWh Dishwasher example and use the current 8 kWh Laundry example for Washer–Dryer Combo. Seed the new Washer and Dryer with editable example values. Built-ins can be reset to defaults.
- Custom loads have a nonempty name, total energy (kWh), and duration. Seed one editable/deletable example at the current Custom value of 20 kWh, with an example duration. The user can create, edit, and delete them. Use stable IDs so renaming a load does not change selection unexpectedly.
- Car keeps its prominent battery representation in the detail view. Its sheet uses steppers for battery capacity, initial state of charge, and desired end state of charge. It has one Level 1 / Level 2 control, defaulting to Level 2. Use internal approximate wall-power and charging-efficiency constants for each level, with Level 2 at 9 kW and Level 1 around 1.5 kW. Do not expose those detailed values in this version. Show both battery energy to add and estimated energy drawn from the wall; label duration and cost as approximate.
- Persist a versioned profile collection and last selected profile using local device storage. The same collection is used for every site. A missing or invalid saved collection falls back to the defaults without losing the ability to edit profiles.

## Start-now presentation

- Keep the load picker in the detail view. Move all editing controls into the configuration sheet.
- Replace the per-tariff hypothetical cost rows with a single start-now estimate for the selected profile: total cost, expected finish time, and a compact breakdown of energy and cost by tariff period encountered during the run.
- Replace the hard-coded Dishwasher/Laundry/Car thresholds in the large “Can run now” panel. It should describe the selected load's start-now estimate and current balance, without claiming a load is free or guaranteed to be covered. Retain the source-time and stale-data cues.
- If Car's target is at or below its initial charge, show that no charging is needed and suppress the cost estimate.
- Keep clear unavailable states for missing tariffs, unusable rates, or an incomplete schedule horizon. Do not display a partial total as if it covers the full load.

## Estimate model and data flow

The server already owns tariff schedules and site timezones. Extend the mobile bill response with timestamped upcoming tariff segments (period key, start, end, buy rate, sell rate), covering the supported maximum load duration. Determine boundaries from the schedule at its actual minute precision and across daylight saving and seasonal changes. The existing observed period balances and source time remain the starting snapshot.

The phone calculates the selected load's energy and duration. For appliances and custom loads, distribute the configured kWh evenly over the configured duration. For Car, battery energy is `capacity × max(target SOC − initial SOC, 0) / 100`; divide by the selected level's efficiency to estimate wall energy, then divide wall energy by its assumed wall power to estimate duration. These assumptions deliberately avoid appliance power curves, car charge taper, and future solar or household-load forecasts.

Split the run at each tariff transition. Allocate energy by overlap time and price it with that segment's rates. Start with the billing cycle's observed net-export balance for each tariff period. Consume positive banked surplus at the sell rate (foregone export credit); price remaining energy at the buy rate. Carry the remaining balance forward by period key so multiple segments of the same period cannot spend the same surplus twice. Where a future period has no observed balance, use zero banked surplus and say so in the breakdown. Treat these values as a snapshot, not a prediction of the balance at finish time.

No Tesla history request is needed for a profile selection or estimate recalculation. Changing a profile recalculates locally using the latest bill response. A bill refresh updates both the balance snapshot and tariff timeline.

## Verification

Cover profile defaults, local persistence, edits, deletion, reset, validation, and last selection. Cover tariff boundaries, repeated periods, unobserved balances, daylight saving, insufficient timeline, zero Car charge, Level 1/Level 2 durations, and non-finite input. Review the SwiftUI sheet and detail previews at large text sizes and with VoiceOver. Run the native test script and repository lint, tests, and build before implementation is completed.
