# iOS load timing design

Date: 2026-09-24
Status: Approved
Base: `ios-fixes` after PR #110 merged; implementation branch `codex/ios-load-timing`

## Goal

Bring the web Site live view's “Load timing this cycle” capabilities to the native iOS dashboard. The feature is a utility section after Current bill. Its dashboard card summarizes the currently active tariff period; tapping it opens a native detail screen with the full web capability.

## Dashboard and detail

The dashboard order is Live power, Today so far, Current bill, then Load timing. Load timing uses the current card/navigation style. The collapsed card names the active tariff period and shows its marginal cost per kWh and its accumulated surplus or deficit for the current billing cycle. Marginal cost means the sell rate when that period has a net surplus and the buy rate when it has a deficit; near balance follows the web's neutral rule. If the active period has no observations in this cycle, show its configured buy rate and “No balance yet.” The card is distinct from the bill estimate and does not display total bill cost.

The detail screen reproduces the web card's useful capabilities with native controls: a next-cheaper-period message (or a justified cheapest-now message), a tile for each observed tariff period with marginal cost, surplus/deficit, active marker and next start, and the “Can I run this now?” estimator. The estimator includes the existing load presets, a custom 1–100 kWh slider, one estimate per configured current-season period, the covered/bought proportion, and the web's covered/tight/partial/bought/unknown states. Configured periods not yet observed may appear in the estimator while the observed-period tiles remain limited to cycle data. Show billing-cycle dates and energy source time. The detail view supports pull-to-refresh like Current bill and does not own a polling loop.

## Data flow

Use the existing mobile coordinator and two cadences. The five-minute live response supplies the dashboard summary. The site-live-data route already resolves the current schedule and derives active-period cycle surplus from the cached completed-day rollup plus today's bins. Extend the mobile contract with a small, explicit active load-timing summary and the source timestamp. Derive the marginal rate on the server using the same buy/sell/neutral rule as the web. Avoid a new full-cycle query or Tesla call on that hot path. Distinguish an active period with no observations from a measured zero balance; the current helper can return zero when only other periods have observations.

The 30-minute bill response supplies the full detail payload. It already reads current-cycle usage by TOU; pass that usage and the current tariff schedule through the canonical `computeLoadTiming` calculation. Reuse its period/pricing data and cheaper-period logic rather than duplicating tariff rules in Swift. The iOS client performs the load-size arithmetic locally from server-provided period pricing, using the same formulas and preset definitions as the web. The bill and load-timing detail refresh together. On dashboard pull-to-refresh, the existing coordinator refreshes live before bill. On detail pull-to-refresh, refresh the slower detail data through the coordinator; neither navigation nor the detail screen starts a poller.

The dashboard summary may be newer than the full detail. Show each payload's actual source/calculation time, keep existing values visibly stale after failed refreshes, and never imply that the bill cadence is live. At a period transition, the next live response changes the collapsed card within the normal five-minute cadence. The detail view uses its last successful cycle snapshot until its scheduled or manual refresh.

## Empty and failure states

No tariff or active schedule: show an explanatory unavailable state rather than a cost. No cycle observations: show the configured active buy rate with “No balance yet” in the dashboard card; detail explains that period recommendations need usage. Missing or stale energy data: retain the last successful snapshot with its true source time and an unavailable/stale label. If a period's rates cannot be resolved, show unknown cost rather than zero. Site changes, billing-cycle rollover and revoked authorization follow existing coordinator behavior and clear or replace prior-site data.

## Verification

Compare server values with the web `computeLoadTiming` calculation for the same site and instant. Cover surplus, deficit, neutral, an unobserved active period, missing rates, period transitions, seasonal changes, site-local cycle rollover and DST boundaries. Test native card ordering, navigation, presets/slider outcomes, accessible labels, loading/empty/stale states and pull-to-refresh. Check the live route's query/egress trace to confirm that the new summary adds no cycle read or Tesla request. Run the repository's Next.js test, lint and build gates and the iOS `run-tests.sh` script.

## Implementation boundary

Start from the iOS UI branch state that includes the post-PR #110 improvements. Preserve unrelated uncommitted UI edits in the user's checkout. No database migration, new poller, background activity or battery control is required.
