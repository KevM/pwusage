# iOS architecture design

Date: 2026-09-23
Status: Approved for implementation planning
Branch: `codex/ios-architecture`

## Decision

Build a native, read-only iPhone app backed by the existing pwusage server. Treat it as a richer, interactive presentation of the current-state information available to TRMNL, not as a port of the Tesla data engine or a web-view wrapper. The server remains the source of truth for Tesla credentials, site authorization, ingestion, tariff history, time-of-use calculations, and the current bill. The iPhone renders those results with native navigation and controls for exploring the data.

The first release covers live site status and the current billing cycle. Battery commands, tariff editing, widgets, notifications, full web feature parity, and an offline guarantee are outside its first-release scope.

## Alternatives considered

| Approach | Benefit | Cost | Decision |
| --- | --- | --- | --- |
| Web view around the existing site | Fastest route to an installable app | Limited native experience and tied to web page layout | Reject for the stated native goal |
| Native client with pwusage server | Native presentation while reusing the proven data and billing system | Requires mobile-facing API shaping and a login handoff | Choose |
| Full iOS data engine | Can continue calculating without the pwusage server | Duplicates token handling, history storage, tariff versions, billing logic, and Tesla call safeguards | Defer unless server independence becomes a requirement |

## Existing system boundaries

The Next.js application in `cmd/next-app` already stores Tesla tokens on the server and authorizes human users through the `site_auth` JWT cookie. The TRMNL markup route loads stored data, aggregates the current cycle and today, renders markup, and schedules throttled Tesla refreshes. The website's site header calls `/api/site-live-data` every five minutes while visible; the live detail view refreshes its larger server-rendered data every 30 minutes. These are the iOS cadence references. The products page has a separate 60-second poller and is not the model for the first iOS dashboard.

The iOS presentation must consume structured values, not TRMNL HTML or a screenshot. Domain calculations should be shared with the web and TRMNL paths where they are already canonical. A refactor may extract snapshot assembly from the TRMNL route, but must preserve its database-first response, background Tesla refresh, 15-minute device cadence, and battery state-of-charge staleness rules.

## First-release data flow

1. The iOS app loads a site dashboard when opened or when it returns to the foreground. One app-level data coordinator owns requests and shares the result across screens; navigation does not start another poller.
2. Live status follows the site's web header behavior: an immediate foreground load, then at most one scheduled request every five minutes while the app remains active. On foreground return, fetch only if the locally held response has passed that interval. No background polling.
3. Load a compact current-bill summary with the initial dashboard. The bill detail screen reuses that response for its period breakdown and may request additional detail only when opened. Bill data refreshes no more often than every 30 minutes while active, unless the user changes sites or the billing cycle changes. The client keeps the latest response in memory to avoid duplicate requests during navigation.
4. The server returns compact, site-scoped structured responses. Prefer evolving the existing live endpoint and adding a focused bill summary response over making every five-minute live request read and return a full billing cycle. The exact endpoint split is finalized after the egress measurement spike.
5. Every value group carries its actual source timestamp, including the latest energy sample and last successful live-status fetch. The request time is not a substitute for data freshness. Stale battery state of charge is unknown, matching the TRMNL rule; the app must not label old data as live.
6. The server keeps the existing per-site Tesla refresh claims and throttles. An iOS request must not create a separate Tesla refresh path or increase billable calls merely because the app is open or the user changes screens.

## Authentication and authorization

Use the existing `site_auth` JWT and site authorization checks for iOS API access. Do not create an independent native authorization model or send Tesla tokens to the phone.

The app begins login with the existing server-owned Tesla OAuth flow in the system web authentication session. After the server completes its normal callback and provisions the user and sites, it redirects to the app with a short-lived, single-use handoff code. The app exchanges that code with pwusage using its own `URLSession`; the response sets an HTTP-only, secure `site_auth` cookie in that session's cookie store. The app then calls the existing cookie-authorized web APIs. This explicit exchange avoids assuming that the web authentication session and the app's network session share cookies.

The handoff must be bound to the login attempt, expire quickly, be consumed atomically, and never contain the JWT or Tesla tokens in the redirect URL. The exchange is a login-time operation, not a per-poll database lookup. Existing JWT renewal and active-user checks remain in force. Logout clears the app's pwusage cookie and calls the existing server logout path. Device testing must confirm cookie persistence, renewal, expiry, and logout behavior.

## Database egress and API budget

The shared PostgreSQL database has a 5 GB monthly egress limit. Mobile access must be budgeted against the website and TRMNL traffic together. A previous web measurement found about 8.7 KB of database output for the 24-hour bucketed live query per five-minute poll; adding separate cycle aggregates and today's raw rows to that hot path would add about 21 KB per poll and was rejected. The first iOS design must not repeat that pattern.

Before implementation is accepted:

- Measure database bytes and query count for cold and warm live and bill requests against representative sites, including a late billing cycle and many tariff schedule rows.
- Model one phone active for 1, 8, and 24 hours per day, plus multiple simultaneous phones, and compare it with the equivalent site header and live detail web usage. Include authentication reads and serverless cold starts.
- Keep the five-minute response limited to live data and small, already needed context. Use existing bucketed data in memory for derived indicators; avoid full-cycle or raw-today reads on each poll.
- Cache or pre-aggregate completed-day billing work using a scheme that remains correct across serverless instances, tariff edits, site-local midnight, and billing-cycle rollover. The implementation plan must choose and measure the concrete mechanism; in-process caching alone does not guarantee a cross-instance egress bound.
- Set an explicit per-active-phone monthly egress estimate from the measurements before expanding the rollout. If the estimate exceeds equivalent website usage, revise the queries or cadence before release.

Network response size and database egress are different measurements. Small JSON alone does not prove low database egress.

## UI and failure behavior

The default screen presents battery charge and direction, solar, home, and grid power, active tariff, today-so-far energy, current bill estimate, and clear data timestamps. A bill detail screen shows the current cycle dates and period breakdown. Native charts may use compact server-provided series only when the user opens the relevant detail; chart history is not part of every live poll.

If a request fails, the app may keep the last response visible during the current session but labels it with its source time and an unavailable or stale state. It never silently advances a “last updated” label when only the request ran. Unauthorized or revoked sessions lead to a clear sign-in prompt. A site with missing tariffs or no energy data shows a specific empty state. There is no first-release promise to work offline or keep collecting data after the pwusage server is unavailable.

## Verification and rollout

Test login handoff replay and expiry, cookie authorization and renewal, site isolation, revoked users, stale battery state of charge, billing-cycle and site-timezone boundaries, tariff version changes, and foreground/background request cadence. Compare iOS-facing bill values with the existing web and TRMNL calculations for the same site and instant. Measure database egress before and after the new API on representative data; preserve or improve the equivalent web access baseline. Exercise the native screens on a real device for cookie persistence and lifecycle behavior.

Begin with one site and the two read-only screens. Expand only after auth, parity, freshness, and egress gates pass. The implementation plan should start with an egress measurement and API contract phase before building the full native interface.
