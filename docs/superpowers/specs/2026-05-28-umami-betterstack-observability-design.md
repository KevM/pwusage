# Umami + Better Stack Observability — Design

**Date:** 2026-05-28
**Status:** Approved for implementation planning
**Author:** brainstorming session

## Goal

Give the operator (Kevin) a useful viewport into who is using PWUsage and what happened on the server beyond Vercel's 1-hour log retention. Primary use case: **engagement** (who's using it, which features). Secondary use case: monitoring the recently-noticed Tesla re-auth pain so we can root-cause it.

This is not an ops/SRE platform build-out. We are explicitly not migrating all 167 `console.*` callsites to a structured logger, not building latency dashboards, not adding tracing.

## Tools

- **Umami Cloud** (cloud.umami.is) — pageviews, custom events, identified users. Free tier (10k events/mo).
- **Better Stack** (formerly Logtail) — log capture and cron heartbeats. Free tier (~3 days retention) acceptable for hobby scale.

## Architecture overview

```
                           ┌─── Umami Cloud
                           │     (script tag + identify + 12 events)
   Next.js app (Vercel) ───┤
                           │
                           ├─── Better Stack Telemetry
                           │     (SDK-based ingest from selected callsites)
                           │
                           └─── Better Stack Uptime (Heartbeats)
                                 (cron routes POST on success → alert on silence)
```

Three independent integrations. Each is env-var gated; each silently no-ops when its env vars are missing, so local dev and tests produce zero outbound traffic.

## Files touched

**New files:**
- `cmd/next-app/src/lib/analytics.ts` — typed `track()` / `identify()` wrapper
- `cmd/next-app/src/lib/analytics.test.ts`
- `cmd/next-app/src/lib/log.ts` — Better Stack SDK wrapper, always also writes to `console.*`
- `cmd/next-app/src/lib/log.test.ts`
- `cmd/next-app/src/lib/with-log.ts` — route-handler wrapper that flushes logs before responding
- `cmd/next-app/src/lib/with-log.test.ts`
- `cmd/next-app/src/lib/heartbeat.ts` — `pingHeartbeat(name)` helper
- `cmd/next-app/src/lib/heartbeat.test.ts`
- `cmd/next-app/src/types/umami.d.ts` — `window.umami` type augmentation
- `cmd/next-app/src/components/AnalyticsIdentify.tsx` — client component that calls `identify()` once per session

**Modified files (Umami):**
- `cmd/next-app/src/app/layout.tsx` — Umami `<Script>` tag (env-gated) + mount `<AnalyticsIdentify />`
- The page receiving the post-callback redirect from `cmd/next-app/src/app/auth/tesla-callback/route.ts` — fire `tesla-login-success` client-side after the redirect lands. The route handler itself is server-side and cannot fire Umami events; implementation must pass the success signal forward (query param, flash cookie, or short-lived session flag).
- `cmd/next-app/src/app/site/[id]/page.tsx` (or its client child) — fire `site-loaded`
- `cmd/next-app/src/components/site/SiteTabs.tsx` — fire `site-tab-changed`
- `cmd/next-app/src/components/site/live/BatteryHoldCard.tsx` — fire `battery-hold-set`, `battery-hold-restored`, `qr-code-opened`
- `cmd/next-app/src/components/site/TariffList.tsx` — fire `tariffs-refreshed`
- `cmd/next-app/src/app/trmnl/install/*` — fire `trmnl-install-success`
- `cmd/next-app/src/app/trmnl/manage/*` — fire `trmnl-manage-viewed`, `trmnl-uninstall`
- `cmd/next-app/src/components/LoadAnalysisClientPage.tsx` — fire `load-analysis-tagged`
- A shared error handler (location to be confirmed during implementation; likely `src/lib/site-live-data-client.ts` or a new helper) — fire `tesla-reauth-needed` when an API call indicates Tesla auth is revoked

**Modified files (Better Stack — log migration on Hobby path):**
- `cmd/next-app/src/lib/tesla-client.ts`
- `cmd/next-app/src/lib/tesla-token-repo.ts`
- `cmd/next-app/src/lib/user-repo.ts`
- `cmd/next-app/src/lib/battery-hold-service.ts`
- `cmd/next-app/src/app/api/cron/cleanup/route.ts`
- `cmd/next-app/src/app/api/cron/check-users/route.ts`
- `cmd/next-app/src/app/api/cron/restore-reserve/route.ts`
- `cmd/next-app/src/app/api/trmnl/markup/route.ts`

Approximately 30–40 `console.*` callsites in these eight files are swapped to `log.*`. All other `console.*` callsites in the repo stay as-is; out of scope.

**Modified files (heartbeats):**
- `cmd/next-app/src/app/api/cron/cleanup/route.ts` — call `pingHeartbeat("cleanup")` at end of successful run
- `cmd/next-app/src/app/api/cron/check-users/route.ts` — call `pingHeartbeat("check-users")` at end of successful run
- `cmd/next-app/src/app/api/cron/restore-reserve/route.ts` — call `pingHeartbeat("restore-reserve")` at end of successful run

**Other:**
- `cmd/next-app/example.env` — document the seven new env vars
- `cmd/next-app/package.json` — add `@logtail/node` (or the Better Stack-recommended Node SDK current at implementation time)

## Umami design

### Script injection

In `cmd/next-app/src/app/layout.tsx`, conditionally render `next/script`:

```tsx
{process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL && process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
  <Script
    src={process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL}
    data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
    strategy="afterInteractive"
  />
)}
```

Two env vars (not just one ID) so we can move off Umami Cloud without code changes if ever needed.

### Wrapper: `src/lib/analytics.ts`

```ts
type Props = Record<string, string | number | boolean | undefined>;

export function track(event: string, props?: Props): void {
  if (typeof window === "undefined") return;
  window.umami?.track(event, props);
}

export function identify(userId: string, traits?: Props): void {
  if (typeof window === "undefined") return;
  window.umami?.identify(userId, traits);
}
```

Every call is safe whether or not the script loaded — the optional chain means no try/catch boilerplate at call sites.

### identify() flow

A small client component `AnalyticsIdentify` mounted in `layout.tsx` reads the logged-in user (mechanism to be confirmed during implementation — either an existing session context, or a small `/api/me`-style fetch) and calls `identify(user.id, { email })` once per session. Skipped on unauthenticated pages.

### Event taxonomy

| # | Event | Where | Props |
|---|---|---|---|
| 1 | `tesla-login-success` | Client-side, on the page the Tesla OAuth callback redirects to (the callback itself is a server route handler; Umami can only fire from the browser). Detected via a session flag or query param. | `{ is_reauth: boolean }` |
| 2 | `tesla-reauth-needed` | client-side, when an API call returns Tesla auth-revoked | `{ site_id?, last_login_at? }` |
| 3 | `site-loaded` | `site/[id]/page.tsx` mount (client child) | `{ site_id, has_battery_hold: boolean }` |
| 4 | `site-tab-changed` | `SiteTabs.tsx` on click | `{ site_id, tab_name }` |
| 5 | `battery-hold-set` | `BatteryHoldCard.tsx` confirm | `{ site_id, target_pct, hours }` |
| 6 | `battery-hold-restored` | `BatteryHoldCard.tsx` restore confirm | `{ site_id }` (manual only) |
| 7 | `tariffs-refreshed` | `TariffList.tsx` refresh button | `{ site_id }` |
| 8 | `trmnl-install-success` | `trmnl/install` success path | `{ site_id }` |
| 9 | `trmnl-manage-viewed` | `trmnl/manage` page mount | `{ site_id, has_installation: boolean }` |
| 10 | `trmnl-uninstall` | `trmnl/manage` uninstall confirm | `{ site_id }` |
| 11 | `load-analysis-tagged` | `LoadAnalysisClientPage.tsx` tag submit | `{ site_id, tag }` |
| 12 | `qr-code-opened` | `BatteryHoldCard.tsx` QR button | `{ site_id }` |

**Naming convention:** `noun-verb` or `subject-result`, past tense for completed actions. These names are stable; renaming breaks historical reports.

**Prop policy:**
- Never log email, raw tokens, or PII beyond `user.id` (already in `identify()`).
- `site_id` is opaque to Umami's view; fine to include for slicing.
- Only booleans, numbers, and short strings.

**Notable absences:** No event fires for the cron-driven battery restore. Cron restores are visible in Better Stack (log line + heartbeat). Combined dashboards mentally union the two: manual restores from Umami, cron restores from Better Stack.

## Better Stack design

### Log capture (Hobby plan → SDK)

Vercel Hobby does not support Log Drains, so we ship logs from code via the Better Stack Node SDK.

`src/lib/log.ts`:

```ts
import { Logtail } from "@logtail/node"; // package name to be confirmed at implementation time

const token = process.env.BETTERSTACK_SOURCE_TOKEN;
const endpoint = process.env.BETTERSTACK_INGEST_URL;
const lt = token && endpoint ? new Logtail(token, { endpoint }) : null;

type Ctx = Record<string, unknown>;
type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, message: string, ctx?: Ctx): void {
  const consoleFn = console[level] ?? console.log;
  ctx ? consoleFn(message, ctx) : consoleFn(message);
  lt?.[level](message, ctx);
}

export const log = {
  info:  (m: string, c?: Ctx) => emit("info", m, c),
  warn:  (m: string, c?: Ctx) => emit("warn", m, c),
  error: (m: string, c?: Ctx) => emit("error", m, c),
  debug: (m: string, c?: Ctx) => emit("debug", m, c),
  flush: () => lt?.flush() ?? Promise.resolve(),
};
```

**Why always also write to console:** keeps Vercel's 1-hour window useful for immediate debugging, keeps local dev terminal output unchanged, and gives a fallback if Better Stack ingest fails.

### Serverless flush wrapper

Vercel functions can terminate before the SDK has flushed buffered logs. To prevent loss:

`src/lib/with-log.ts`:

```ts
import { log } from "./log";
import type { NextRequest } from "next/server";

type Handler = (req: NextRequest, ctx: unknown) => Promise<Response>;

export function withLog(handler: Handler): Handler {
  return async (req, ctx) => {
    try {
      const res = await handler(req, ctx);
      await log.flush();
      return res;
    } catch (err) {
      log.error("Unhandled route error", { url: req.url, err: String(err) });
      await log.flush();
      throw err;
    }
  };
}
```

Applied to the migrated routes (the three crons and `/api/trmnl/markup`). Adds ~5–50ms of tail latency in exchange for reliable log delivery. Call sites in plain library code (`tesla-client.ts`, etc.) don't need the wrapper — their flushing happens when the calling route handler completes.

### Migration scope

`console.*` callsites swapped to `log.*` in exactly these eight files:

1. `cmd/next-app/src/lib/tesla-client.ts`
2. `cmd/next-app/src/lib/tesla-token-repo.ts`
3. `cmd/next-app/src/lib/user-repo.ts`
4. `cmd/next-app/src/lib/battery-hold-service.ts`
5. `cmd/next-app/src/app/api/cron/cleanup/route.ts`
6. `cmd/next-app/src/app/api/cron/check-users/route.ts`
7. `cmd/next-app/src/app/api/cron/restore-reserve/route.ts`
8. `cmd/next-app/src/app/api/trmnl/markup/route.ts`

During migration, audit for accidental token/secret logging and redact. Existing `[ComponentName]` prefixes in log messages are preserved (e.g., `[TokenLock] Terminal auth failure ...`) so log-based searches and alerts keep working with the same patterns.

All other `console.*` callsites in the repo stay as-is. They continue to work locally and within Vercel's 1-hour window; they just don't reach Better Stack. This is a deliberate scope decision and is captured in `TODO.md` under "later observability work."

### Cron heartbeats

`src/lib/heartbeat.ts`:

```ts
const URLS: Record<string, string | undefined> = {
  "cleanup": process.env.BETTERSTACK_HEARTBEAT_CLEANUP,
  "check-users": process.env.BETTERSTACK_HEARTBEAT_CHECK_USERS,
  "restore-reserve": process.env.BETTERSTACK_HEARTBEAT_RESTORE_RESERVE,
};

export async function pingHeartbeat(name: keyof typeof URLS): Promise<void> {
  const url = URLS[name];
  if (!url) return;
  await fetch(url, { method: "POST" }).catch(() => {});
}
```

Called at the end of each cron route's successful execution path. Better Stack alerts (Slack/email, configured in UI) fire if a heartbeat doesn't arrive within the configured window (cron cadence + grace).

Each heartbeat is configured in the Better Stack UI under **Uptime → Heartbeats** with the cron's schedule and a grace period (e.g., 15 minutes for daily crons).

### Log-based alerts (configured in Better Stack UI, no code)

Documented here so they aren't forgotten during setup:

1. **Tesla auth wall** — alert when log lines matching `Terminal auth failure for site` exceed 3 occurrences per hour. Directly addresses the re-auth pain noted as a current concern. The matching line is emitted by `tesla-token-repo.ts` (which is in the migrated file list).
2. **Cron error logs** — alert immediately on any `error`-level log line emitted from a path under `/api/cron/`. Belt-and-suspenders with the heartbeats: heartbeats catch "didn't run," this catches "ran but errored."

## Re-auth observability — combined dashboard

The current re-auth pain is monitored via three independent signals:

| Signal | Source | Tells you |
|---|---|---|
| `tesla-reauth-needed` event count | Umami | How often users hit the wall |
| `tesla-login-success` with `is_reauth: true` count | Umami | How many recover via re-auth (vs. drop off) |
| `Terminal auth failure` log count + Better Stack alert | Better Stack | Server-side root cause and timing |

A delta between reauth-needed and the recovery count indicates user drop-off. A spike in the Better Stack alert correlates causes.

## Environment variables

Seven new vars total. All set in **Vercel → Project Settings → Environment Variables**, **Production scope only** (preview deployments and local dev silently no-op).

| Var | Public? | Purpose |
|---|---|---|
| `NEXT_PUBLIC_UMAMI_SCRIPT_URL` | Public | Umami script src (e.g., `https://cloud.umami.is/script.js`) |
| `NEXT_PUBLIC_UMAMI_WEBSITE_ID` | Public | Umami website ID (Kevin's: `947f4b6f-4f72-4ef6-a7b2-dff8dd0b49d0`) |
| `BETTERSTACK_SOURCE_TOKEN` | Secret | Logs SDK token |
| `BETTERSTACK_INGEST_URL` | Secret | Logs SDK ingest endpoint (regional) |
| `BETTERSTACK_HEARTBEAT_CLEANUP` | Secret | Heartbeat URL for cleanup cron |
| `BETTERSTACK_HEARTBEAT_CHECK_USERS` | Secret | Heartbeat URL for check-users cron |
| `BETTERSTACK_HEARTBEAT_RESTORE_RESERVE` | Secret | Heartbeat URL for restore-reserve cron |

`example.env` gets each var documented with a comment indicating its source (where to find/generate it).

## Privacy posture

- Umami `identify()` carries `user.id` and `email`. This is acceptable because Kevin is the sole operator of a personal-scale app; this is not anonymous-by-design territory. Umami is cookieless, so no GDPR cookie banner is required.
- No tokens or refresh tokens are ever logged. Existing `console.*` callsites are audited during migration to confirm.
- Event props beyond `identify()` carry only opaque IDs (`site_id`), booleans, numbers, and short strings — no PII.

## Local dev and test behavior

- All wrappers (`analytics.ts`, `log.ts`, `heartbeat.ts`) silently no-op when their env vars are unset.
- `log.*` always emits to `console.*`, so local `npm run dev` terminal output is unchanged.
- `npm test` produces zero outbound network traffic to any of these services.
- Tests assert no-op behavior explicitly so refactors can't accidentally introduce dev-time analytics noise.

## Testing

Tests are scoped to the wrappers, not to every call site (call sites are trivial wiring).

- `analytics.test.ts`: `track()` and `identify()` no-op when `window.umami` is missing (SSR / unconfigured); pass through to `window.umami.*` when present.
- `log.test.ts`: each level always invokes the matching `console.*`; invokes the SDK only when configured; `flush()` resolves silently when SDK absent.
- `heartbeat.test.ts`: no-ops when URL missing; POSTs to configured URL; swallows network errors.
- `with-log.test.ts`: route wrapper returns the handler's response only after `flush()` is awaited; on thrown error, logs and re-throws after flush.

Build/lint gates unchanged: `npm run lint`, `npm run build`, `npm test` must pass.

**Optional follow-up (not in scope):** an ESLint rule banning `console.*` in the eight migrated files to prevent regressions.

## Out of scope (parked in TODO.md)

- Migrating the remaining ~130 `console.*` callsites to `log.*`
- Per-route latency dashboards / p95 charts
- Request tracing (OpenTelemetry)
- Self-hosting Umami or Better Stack
- Tracking pageviews from unauthenticated/anonymous visitors as a separate segment
- Vercel Analytics (Core Web Vitals); can revisit later if interested

## Open items (resolve during implementation, not blocking spec)

- Confirm the current Better Stack Node SDK package name (`@logtail/node` historically; verify against Better Stack docs at implementation time — Better Stack renamed Logtail and the package name may have shifted).
- Confirm the cleanest place to fire `tesla-reauth-needed` — likely a shared client-side fetch error handler. Implementation plan should identify the exact file.
- Confirm whether the user/session is exposed to client components via context or requires a small `/api/me` fetch for `AnalyticsIdentify`.
- Decide the mechanism by which `tesla-login-success` is signalled from the server-side callback to the client page (query param, flash cookie, or session flag) and which page receives the redirect.
- Confirm whether `BETTERSTACK_INGEST_URL` needs to be a separate env var or whether the SDK uses a default endpoint that makes the var optional.

## Acceptance criteria

- Visiting prod logs a pageview in Umami. The 12 events listed fire from their stated locations (manual smoke test).
- `identify()` fires after Tesla login; subsequent events in the same session appear attributed to that user in Umami.
- A log line emitted from one of the eight migrated files appears in Better Stack within ~10s of the request completing.
- Killing one cron's heartbeat URL (or a real cron failure) triggers a Better Stack alert.
- `npm run dev` and `npm test` produce no network traffic to Umami or Better Stack.
- `npm run lint`, `npm run build`, `npm test` all pass.
