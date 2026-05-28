# Umami + Better Stack Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Umami Cloud (12 client-side events + identify) and Better Stack (server-side logging SDK + cron heartbeats) into the Next.js app at `cmd/next-app`, with strict env-var gating so local dev and tests stay silent.

**Architecture:** Three independent integrations: (1) Umami script tag + client wrapper firing events from existing UI components; (2) Better Stack Node SDK wrapped behind a `log.*` API that always also writes to `console.*`; (3) Cron heartbeat pings POSTed from the three existing cron routes. All gated by env vars; missing vars = silent no-op. Eight files (Tesla client, token repo, user repo, battery-hold service, three cron routes, TRMNL markup route) get `console.*` → `log.*`; everything else stays.

**Tech Stack:** Next.js 16 App Router, TypeScript (strict, no `any`), Vitest, `@logtail/node`, Umami HTTP-script.

---

## Spec reference

`docs/superpowers/specs/2026-05-28-umami-betterstack-observability-design.md`

## Open items resolved before plan-writing

- **SDK package**: `@logtail/node`. T16 install task verifies current version.
- **`tesla-reauth-needed` trigger**: API routes already return `409 { error: "needs_reauth" }` when Tesla auth is revoked (see `BatteryHoldCard.tsx:65`). We add a tiny client helper `notifyReauthNeeded()` and call it at each detection point.
- **`AnalyticsIdentify` user source**: `getCurrentUser()` in `src/lib/auth-checks.ts` runs server-side. We invoke it in `layout.tsx` (a server component) and pass `userId`/`email` as props to a client `<AnalyticsIdentify>` component. No new endpoint.
- **`tesla-login-success` mechanism**: `/auth/tesla-callback/route.ts` redirects to `savedCallback || '/'`. We append `?login=success&new=<bool>` to that redirect target (the `new` derived from `upsertOnTeslaAuth` return value). The landing page detects the query string and fires the event, then `router.replace`s to strip the params.

## File structure

**Create (new files):**

| Path | Responsibility |
|---|---|
| `cmd/next-app/src/lib/analytics.ts` | `track()`, `identify()` — Umami wrapper, no-op when script absent |
| `cmd/next-app/src/lib/analytics.test.ts` | Unit tests for the above |
| `cmd/next-app/src/lib/log.ts` | `log.{info,warn,error,debug,flush}` — Better Stack SDK + `console.*` fallback |
| `cmd/next-app/src/lib/log.test.ts` | Unit tests |
| `cmd/next-app/src/lib/with-log.ts` | Route-handler wrapper that awaits `log.flush()` before responding |
| `cmd/next-app/src/lib/with-log.test.ts` | Unit tests |
| `cmd/next-app/src/lib/heartbeat.ts` | `pingHeartbeat(name)` — POST to Better Stack heartbeat URLs |
| `cmd/next-app/src/lib/heartbeat.test.ts` | Unit tests |
| `cmd/next-app/src/lib/reauth-signal.ts` | `notifyReauthNeeded(siteId?)` — client-side helper firing `tesla-reauth-needed` |
| `cmd/next-app/src/lib/reauth-signal.test.ts` | Unit tests |
| `cmd/next-app/src/types/umami.d.ts` | `window.umami` type augmentation |
| `cmd/next-app/src/components/AnalyticsIdentify.tsx` | Client component calling `identify()` once per session |
| `cmd/next-app/src/components/LoginSuccessTracker.tsx` | Client component firing `tesla-login-success` from query params |

**Modify:**

| Path | Reason |
|---|---|
| `cmd/next-app/src/app/layout.tsx` | Inject Umami `<Script>`, mount `<AnalyticsIdentify />` |
| `cmd/next-app/src/app/auth/tesla-callback/route.ts` | Append `?login=success&new=...` to redirect target |
| `cmd/next-app/src/lib/user-repo.ts` | `upsertOnTeslaAuth` returns `{ isNew: boolean }`; also migrated to `log.*` in T18 |
| `cmd/next-app/src/app/page.tsx` (or wherever `/` lands) | Mount `<LoginSuccessTracker />` |
| `cmd/next-app/src/app/site/[id]/page.tsx` | Mount `<LoginSuccessTracker />` (also a possible redirect target) |
| `cmd/next-app/src/components/site/SiteTabs.tsx` | Fire `site-loaded` on mount, `site-tab-changed` on tab click |
| `cmd/next-app/src/components/site/live/BatteryHoldCard.tsx` | Fire `battery-hold-set`, `battery-hold-restored`, `qr-code-opened`; call `notifyReauthNeeded` |
| `cmd/next-app/src/components/site/TariffList.tsx` | Fire `tariffs-refreshed` |
| `cmd/next-app/src/app/trmnl/install/page.tsx` (or its client child) | Fire `trmnl-install-success` |
| `cmd/next-app/src/app/trmnl/manage/page.tsx` (or its client child) | Fire `trmnl-manage-viewed` and `trmnl-uninstall` |
| `cmd/next-app/src/components/LoadAnalysisClientPage.tsx` | Fire `load-analysis-tagged` |
| `cmd/next-app/src/components/SiteLiveStats.tsx` | Call `notifyReauthNeeded` when its fetch returns 401-revoked |
| `cmd/next-app/src/components/HeaderLiveStats.tsx` | Same |
| `cmd/next-app/src/components/DashboardCards.tsx` | Same |
| `cmd/next-app/src/lib/tesla-client.ts` | `console.*` → `log.*` |
| `cmd/next-app/src/lib/tesla-token-repo.ts` | `console.*` → `log.*` |
| `cmd/next-app/src/lib/user-repo.ts` | `console.*` → `log.*` |
| `cmd/next-app/src/lib/battery-hold-service.ts` | `console.*` → `log.*` |
| `cmd/next-app/src/app/api/cron/cleanup/route.ts` | `console.*` → `log.*`, wrap in `withLog`, call `pingHeartbeat("cleanup")` |
| `cmd/next-app/src/app/api/cron/check-users/route.ts` | Same with `"check-users"` |
| `cmd/next-app/src/app/api/cron/restore-reserve/route.ts` | Same with `"restore-reserve"` |
| `cmd/next-app/src/app/api/trmnl/markup/route.ts` | `console.*` → `log.*`, wrap in `withLog` |
| `cmd/next-app/example.env` | Document the 7 new env vars |
| `cmd/next-app/package.json` | Add `@logtail/node` |

---

## Phase 1: Foundation wrappers (Tasks 1–6)

Build the env-gated no-op-safe wrappers first. After Phase 1 the codebase compiles, tests pass, and zero behavior has changed — but the surface is ready for everything else.

### Task 1: Umami client wrapper

**Files:**
- Create: `cmd/next-app/src/types/umami.d.ts`
- Create: `cmd/next-app/src/lib/analytics.ts`
- Test:   `cmd/next-app/src/lib/analytics.test.ts`

- [ ] **Step 1: Add the `window.umami` type augmentation**

Create `cmd/next-app/src/types/umami.d.ts`:

```ts
export {};

declare global {
  interface Window {
    umami?: {
      track: (event: string, props?: Record<string, unknown>) => void;
      identify: (userId: string, traits?: Record<string, unknown>) => void;
    };
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `cmd/next-app/src/lib/analytics.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { track, identify } from './analytics';

describe('analytics wrapper', () => {
  const realWindow = globalThis.window;

  afterEach(() => {
    // Restore between tests
    if (realWindow) {
      (globalThis as { window?: Window }).window = realWindow;
    } else {
      delete (globalThis as { window?: Window }).window;
    }
    vi.restoreAllMocks();
  });

  it('track() is a no-op when window is undefined (SSR)', () => {
    delete (globalThis as { window?: Window }).window;
    expect(() => track('event-name', { x: 1 })).not.toThrow();
  });

  it('identify() is a no-op when window is undefined (SSR)', () => {
    delete (globalThis as { window?: Window }).window;
    expect(() => identify('user-1', { email: 'a@b' })).not.toThrow();
  });

  it('track() is a no-op when window.umami is missing', () => {
    (globalThis as { window?: Window }).window = { } as Window;
    expect(() => track('event-name')).not.toThrow();
  });

  it('track() forwards to window.umami.track when present', () => {
    const trackSpy = vi.fn();
    (globalThis as { window?: Window }).window = {
      umami: { track: trackSpy, identify: vi.fn() },
    } as unknown as Window;
    track('event-name', { site_id: 's' });
    expect(trackSpy).toHaveBeenCalledWith('event-name', { site_id: 's' });
  });

  it('identify() forwards to window.umami.identify when present', () => {
    const identifySpy = vi.fn();
    (globalThis as { window?: Window }).window = {
      umami: { track: vi.fn(), identify: identifySpy },
    } as unknown as Window;
    identify('user-1', { email: 'a@b' });
    expect(identifySpy).toHaveBeenCalledWith('user-1', { email: 'a@b' });
  });
});

beforeEach(() => {
  // no-op, kept for symmetry with afterEach restoration
});
```

- [ ] **Step 3: Run the test — expect failure**

Run from `cmd/next-app`:

```bash
npm test -- src/lib/analytics.test.ts
```

Expected: FAIL — `Cannot find module './analytics'`.

- [ ] **Step 4: Implement `analytics.ts`**

Create `cmd/next-app/src/lib/analytics.ts`:

```ts
type Props = Record<string, string | number | boolean | undefined>;

export function track(event: string, props?: Props): void {
  if (typeof window === 'undefined') return;
  window.umami?.track(event, props);
}

export function identify(userId: string, traits?: Props): void {
  if (typeof window === 'undefined') return;
  window.umami?.identify(userId, traits);
}
```

- [ ] **Step 5: Run the test — expect pass**

```bash
npm test -- src/lib/analytics.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 6: Verify build + lint**

```bash
npm run lint
npm run build
```

Both must pass.

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/analytics.ts cmd/next-app/src/lib/analytics.test.ts cmd/next-app/src/types/umami.d.ts
git commit -m "feat(analytics): add Umami client wrapper

track() and identify() no-op when window.umami is absent (SSR, dev,
unconfigured). Foundation for the 12 events landing in subsequent
tasks."
```

---

### Task 2: Better Stack log wrapper

**Files:**
- Create: `cmd/next-app/src/lib/log.ts`
- Test:   `cmd/next-app/src/lib/log.test.ts`
- Modify: `cmd/next-app/package.json` (add `@logtail/node`)

- [ ] **Step 1: Install the Better Stack SDK first**

The `log.ts` file we're about to write imports `@logtail/node`. Install it now so the test runner can resolve the module. From `cmd/next-app`:

```bash
npm install @logtail/node
```

Confirm `package.json` now lists `@logtail/node` under `dependencies`. Verify the version installed matches the current Better Stack-recommended Node SDK (check https://betterstack.com/docs/logs/javascript/nodejs/ — if Better Stack has renamed/superseded the package, install the recommended one and update the import in Step 3 below).

- [ ] **Step 2: Write the failing test**

Create `cmd/next-app/src/lib/log.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('log wrapper', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.BETTERSTACK_SOURCE_TOKEN;
    delete process.env.BETTERSTACK_INGEST_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('log.info forwards to console.info', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { log } = await import('./log');
    log.info('hello', { a: 1 });
    expect(spy).toHaveBeenCalledWith('hello', { a: 1 });
  });

  it('log.warn forwards to console.warn', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { log } = await import('./log');
    log.warn('careful');
    expect(spy).toHaveBeenCalledWith('careful');
  });

  it('log.error forwards to console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { log } = await import('./log');
    log.error('boom', { err: 'x' });
    expect(spy).toHaveBeenCalledWith('boom', { err: 'x' });
  });

  it('log.debug forwards to console.debug', async () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { log } = await import('./log');
    log.debug('chatter');
    expect(spy).toHaveBeenCalledWith('chatter');
  });

  it('flush() resolves silently when SDK is not configured', async () => {
    const { log } = await import('./log');
    await expect(log.flush()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run — expect fail**

```bash
npm test -- src/lib/log.test.ts
```

Expected: FAIL — `Cannot find module './log'`.

- [ ] **Step 4: Implement `log.ts`**

Create `cmd/next-app/src/lib/log.ts`:

```ts
import { Logtail } from '@logtail/node';

type Ctx = Record<string, unknown>;
type Level = 'info' | 'warn' | 'error' | 'debug';

const token = process.env.BETTERSTACK_SOURCE_TOKEN;
const endpoint = process.env.BETTERSTACK_INGEST_URL;
const lt: Logtail | null = token
  ? new Logtail(token, endpoint ? { endpoint } : undefined)
  : null;

function emit(level: Level, message: string, ctx?: Ctx): void {
  const consoleFn = console[level] ?? console.log;
  if (ctx !== undefined) {
    consoleFn(message, ctx);
  } else {
    consoleFn(message);
  }
  if (lt) {
    // @logtail/node has matching method names. Wrap in try/catch defensively
    // so an SDK fault never breaks the caller's flow.
    try {
      void lt[level](message, ctx);
    } catch {
      // swallow
    }
  }
}

export const log = {
  info:  (m: string, c?: Ctx): void => emit('info', m, c),
  warn:  (m: string, c?: Ctx): void => emit('warn', m, c),
  error: (m: string, c?: Ctx): void => emit('error', m, c),
  debug: (m: string, c?: Ctx): void => emit('debug', m, c),
  flush: async (): Promise<void> => {
    if (!lt) return;
    try {
      await lt.flush();
    } catch {
      // swallow
    }
  },
};
```

> If Step 1 installed a different package name, change the import accordingly.

- [ ] **Step 5: Run the test — expect pass**

```bash
npm test -- src/lib/log.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 6: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/log.ts cmd/next-app/src/lib/log.test.ts cmd/next-app/package.json cmd/next-app/package-lock.json
git commit -m "feat(log): add Better Stack log wrapper

log.{info,warn,error,debug} always emit to console.* and additionally
to Better Stack when BETTERSTACK_SOURCE_TOKEN is set. flush() is a
silent no-op when unconfigured. SDK errors are swallowed."
```

---

### Task 3: `withLog` route wrapper

**Files:**
- Create: `cmd/next-app/src/lib/with-log.ts`
- Test:   `cmd/next-app/src/lib/with-log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/with-log.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { withLog } from './with-log';

vi.mock('./log', () => {
  const calls: string[] = [];
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((m: string) => { calls.push(`error:${m}`); }),
      debug: vi.fn(),
      flush: vi.fn(async () => { calls.push('flush'); }),
    },
    __calls: calls,
  };
});

describe('withLog', () => {
  it('awaits flush() before returning the handler response', async () => {
    const order: string[] = [];
    const handler = vi.fn(async () => {
      order.push('handler');
      return new Response('ok');
    });
    const mod = await import('./log') as unknown as { __calls: string[] };
    const wrapped = withLog(handler);
    const res = await wrapped({ url: 'http://x' } as never, {} as never);
    expect(res).toBeInstanceOf(Response);
    expect(handler).toHaveBeenCalledOnce();
    expect(mod.__calls).toContain('flush');
  });

  it('logs and flushes on thrown error, then rethrows', async () => {
    const handler = vi.fn(async () => { throw new Error('bad'); });
    const wrapped = withLog(handler);
    await expect(wrapped({ url: 'http://x' } as never, {} as never)).rejects.toThrow('bad');
    const mod = await import('./log') as unknown as { __calls: string[] };
    expect(mod.__calls.some(c => c.startsWith('error:'))).toBe(true);
    expect(mod.__calls).toContain('flush');
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
npm test -- src/lib/with-log.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `with-log.ts`**

Create `cmd/next-app/src/lib/with-log.ts`:

```ts
import { log } from './log';
import type { NextRequest } from 'next/server';

type Handler<Ctx> = (req: NextRequest, ctx: Ctx) => Promise<Response>;

export function withLog<Ctx>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      const res = await handler(req, ctx);
      await log.flush();
      return res;
    } catch (err) {
      log.error('Unhandled route error', {
        url: req.url,
        err: err instanceof Error ? err.message : String(err),
      });
      await log.flush();
      throw err;
    }
  };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
npm test -- src/lib/with-log.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/with-log.ts cmd/next-app/src/lib/with-log.test.ts
git commit -m "feat(log): add withLog route wrapper

Flushes buffered Better Stack logs before serverless functions
terminate. Logs and flushes on thrown errors before rethrowing."
```

---

### Task 4: Heartbeat helper

**Files:**
- Create: `cmd/next-app/src/lib/heartbeat.ts`
- Test:   `cmd/next-app/src/lib/heartbeat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/heartbeat.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('pingHeartbeat', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.BETTERSTACK_HEARTBEAT_CLEANUP;
    delete process.env.BETTERSTACK_HEARTBEAT_CHECK_USERS;
    delete process.env.BETTERSTACK_HEARTBEAT_RESTORE_RESERVE;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('is a no-op when the URL env var is unset', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { pingHeartbeat } = await import('./heartbeat');
    await pingHeartbeat('cleanup');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to the configured URL when set', async () => {
    process.env.BETTERSTACK_HEARTBEAT_CLEANUP = 'https://uptime.betterstack.com/api/v1/heartbeat/abc';
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { pingHeartbeat } = await import('./heartbeat');
    await pingHeartbeat('cleanup');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://uptime.betterstack.com/api/v1/heartbeat/abc',
      { method: 'POST' },
    );
  });

  it('swallows network errors', async () => {
    process.env.BETTERSTACK_HEARTBEAT_CLEANUP = 'https://uptime.betterstack.com/api/v1/heartbeat/abc';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const { pingHeartbeat } = await import('./heartbeat');
    await expect(pingHeartbeat('cleanup')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
npm test -- src/lib/heartbeat.test.ts
```

- [ ] **Step 3: Implement `heartbeat.ts`**

Create `cmd/next-app/src/lib/heartbeat.ts`:

```ts
const URLS = {
  'cleanup': () => process.env.BETTERSTACK_HEARTBEAT_CLEANUP,
  'check-users': () => process.env.BETTERSTACK_HEARTBEAT_CHECK_USERS,
  'restore-reserve': () => process.env.BETTERSTACK_HEARTBEAT_RESTORE_RESERVE,
} as const;

export type HeartbeatName = keyof typeof URLS;

export async function pingHeartbeat(name: HeartbeatName): Promise<void> {
  const url = URLS[name]();
  if (!url) return;
  try {
    await fetch(url, { method: 'POST' });
  } catch {
    // swallow — heartbeat failure must not break the cron
  }
}
```

> Reading env at call time (via the getter functions) rather than at module load lets tests mutate `process.env` after import. Otherwise our tests would race the module's top-level read.

- [ ] **Step 4: Run — expect pass**

```bash
npm test -- src/lib/heartbeat.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/heartbeat.ts cmd/next-app/src/lib/heartbeat.test.ts
git commit -m "feat(heartbeat): add Better Stack heartbeat helper

POSTs to BETTERSTACK_HEARTBEAT_<NAME> URLs for the three cron names;
no-op when unset, errors swallowed so heartbeat failures don't break
crons."
```

---

### Task 5: Reauth-signal client helper

**Files:**
- Create: `cmd/next-app/src/lib/reauth-signal.ts`
- Test:   `cmd/next-app/src/lib/reauth-signal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/reauth-signal.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./analytics', () => ({
  track: vi.fn(),
  identify: vi.fn(),
}));

describe('notifyReauthNeeded', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires the tesla-reauth-needed event with site_id when provided', async () => {
    const { notifyReauthNeeded } = await import('./reauth-signal');
    const { track } = await import('./analytics');
    notifyReauthNeeded('site-123');
    expect(track).toHaveBeenCalledWith('tesla-reauth-needed', { site_id: 'site-123' });
  });

  it('fires without site_id when not provided', async () => {
    const { notifyReauthNeeded } = await import('./reauth-signal');
    const { track } = await import('./analytics');
    notifyReauthNeeded();
    expect(track).toHaveBeenCalledWith('tesla-reauth-needed', {});
  });

  it('deduplicates within a single page session', async () => {
    const { notifyReauthNeeded, __resetReauthSignal } = await import('./reauth-signal');
    const { track } = await import('./analytics');
    __resetReauthSignal();
    notifyReauthNeeded('site-1');
    notifyReauthNeeded('site-1');
    notifyReauthNeeded('site-1');
    expect(track).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
npm test -- src/lib/reauth-signal.test.ts
```

- [ ] **Step 3: Implement `reauth-signal.ts`**

Create `cmd/next-app/src/lib/reauth-signal.ts`:

```ts
import { track } from './analytics';

// Dedup within the current page session to avoid spamming the event
// when multiple components hit a revoked Tesla token in parallel.
let fired = false;

export function notifyReauthNeeded(siteId?: string): void {
  if (fired) return;
  fired = true;
  const props: Record<string, string> = {};
  if (siteId) props.site_id = siteId;
  track('tesla-reauth-needed', props);
}

// Test-only — not exported from the public surface of the lib.
export function __resetReauthSignal(): void {
  fired = false;
}
```

- [ ] **Step 4: Run — expect pass**

```bash
npm test -- src/lib/reauth-signal.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/reauth-signal.ts cmd/next-app/src/lib/reauth-signal.test.ts
git commit -m "feat(analytics): add reauth-signal helper

notifyReauthNeeded() fires tesla-reauth-needed once per page session
with optional site_id. Dedup prevents parallel components from
double-counting the same auth wall."
```

---

### Task 6: Document new env vars in example.env

**Files:**
- Modify: `cmd/next-app/example.env`

- [ ] **Step 1: Append the new vars**

Append to `cmd/next-app/example.env`:

```bash

# ----- Observability (production only; leave unset locally) -----

# Umami Cloud analytics (public — exposed to browser)
# Sign up at https://cloud.umami.is and create a website to get these.
# NEXT_PUBLIC_UMAMI_SCRIPT_URL="https://cloud.umami.is/script.js"
# NEXT_PUBLIC_UMAMI_WEBSITE_ID="00000000-0000-0000-0000-000000000000"

# Better Stack log ingest (secret — server only)
# Generate a Source in Better Stack Telemetry; copy its token and ingest URL.
# BETTERSTACK_SOURCE_TOKEN="your-source-token"
# BETTERSTACK_INGEST_URL="https://in.logs.betterstack.com"

# Better Stack heartbeat URLs (one per cron — secret)
# Create three Heartbeats in Better Stack Uptime (one per cron schedule)
# and paste each unique POST URL below.
# BETTERSTACK_HEARTBEAT_CLEANUP="https://uptime.betterstack.com/api/v1/heartbeat/xxxx"
# BETTERSTACK_HEARTBEAT_CHECK_USERS="https://uptime.betterstack.com/api/v1/heartbeat/yyyy"
# BETTERSTACK_HEARTBEAT_RESTORE_RESERVE="https://uptime.betterstack.com/api/v1/heartbeat/zzzz"
```

- [ ] **Step 2: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/example.env
git commit -m "docs(env): document Umami + Better Stack env vars

Seven new vars; all commented so local dev stays no-op until they are
filled in. NEXT_PUBLIC_* are public; the rest are secret."
```

---

## Phase 2: Umami integration (Tasks 7–15)

Wire the script, identify, and the 12 events. Each event task follows the same shape: locate the existing click/mount handler, import `track`, fire with props, test the existing behavior still works.

### Task 7: Inject Umami script + AnalyticsIdentify in layout

**Files:**
- Create: `cmd/next-app/src/components/AnalyticsIdentify.tsx`
- Modify: `cmd/next-app/src/app/layout.tsx`

- [ ] **Step 1: Create the client identify component**

Create `cmd/next-app/src/components/AnalyticsIdentify.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import { identify } from '@/lib/analytics';

interface Props {
  userId: string | null;
  email: string | null;
}

export function AnalyticsIdentify({ userId, email }: Props) {
  useEffect(() => {
    if (!userId) return;
    const traits: Record<string, string> = {};
    if (email) traits.email = email;
    identify(userId, traits);
  }, [userId, email]);

  return null;
}
```

- [ ] **Step 2: Inject script + mount component in layout.tsx**

Open `cmd/next-app/src/app/layout.tsx` and add the imports near the existing ones:

```tsx
import Script from 'next/script';
import { AnalyticsIdentify } from '@/components/AnalyticsIdentify';
import { getCurrentUser } from '@/lib/auth-checks';
```

Inside `RootLayout`, before the existing site-fetching block, fetch the user:

```tsx
const currentUser = await getCurrentUser();
```

Replace the `<body>` opening section so it injects the script (conditionally) and mounts `<AnalyticsIdentify>`:

```tsx
return (
  <html lang="en" suppressHydrationWarning>
    <head>
      {process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL && process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
        <Script
          src={process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL}
          data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
          strategy="afterInteractive"
        />
      )}
    </head>
    <body
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} antialiased flex flex-col min-h-screen`}
    >
      <AnalyticsIdentify
        userId={currentUser?.id ?? null}
        email={null /* email not yet exposed by getCurrentUser; leave null for now */}
      />
      <ToastProvider>
        <GlobalHeader showStyleGuide={showStyleGuide} />
        <main className="flex-grow min-h-screen">
          {children}
        </main>
        <Footer />
      </ToastProvider>
    </body>
  </html>
);
```

> `getCurrentUser()` currently returns only `{ id }`. Email enrichment is a small follow-up (extend the return type to include `email` from the JWT). For now we pass `null` so identify uses only the id. Mark this as a future enhancement; do not block the plan on it.

- [ ] **Step 3: Verify build + lint**

```bash
npm run lint
npm run build
```

Expected: both pass. No tests for layout (it's a smoke-only change).

- [ ] **Step 4: Manual smoke (optional, local)**

Set `NEXT_PUBLIC_UMAMI_SCRIPT_URL=https://cloud.umami.is/script.js` and `NEXT_PUBLIC_UMAMI_WEBSITE_ID=947f4b6f-4f72-4ef6-a7b2-dff8dd0b49d0` in a local `.env.local`, run `npm run dev`, open browser devtools network tab, confirm `script.js` loads on a page view. **Remove the vars from `.env.local` after testing** — local dev should normally be silent.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/AnalyticsIdentify.tsx cmd/next-app/src/app/layout.tsx
git commit -m "feat(analytics): inject Umami script and identify users in layout

Script tag is rendered only when both NEXT_PUBLIC_UMAMI_* vars are
set. AnalyticsIdentify reads the server-side user and calls
window.umami.identify() once on mount."
```

---

### Task 8: Fire `tesla-login-success` with `is_reauth`

**Files:**
- Modify: `cmd/next-app/src/lib/user-repo.ts` (return `{ isNew }` from upsertOnTeslaAuth)
- Modify: `cmd/next-app/src/app/auth/tesla-callback/route.ts` (append query params to redirect)
- Create: `cmd/next-app/src/components/LoginSuccessTracker.tsx`
- Modify: `cmd/next-app/src/app/page.tsx` (mount the tracker)
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx` (mount the tracker)

- [ ] **Step 1: Extend `upsertOnTeslaAuth` to report new vs. existing**

Open `cmd/next-app/src/lib/user-repo.ts`. Find `upsertOnTeslaAuth`. It probably runs an `INSERT ... ON CONFLICT ... DO UPDATE`. Change it to capture whether the row already existed.

If the current signature is roughly:

```ts
async upsertOnTeslaAuth(args: { userId: string; email: string | null; accessToken: string; refreshToken: string; tokenExpiresAt: number }): Promise<void> { ... }
```

Change the return type to `Promise<{ isNew: boolean }>` and use a query that distinguishes. A robust pattern with Postgres:

```sql
INSERT INTO "User" (...) VALUES (...)
ON CONFLICT (id) DO UPDATE SET ...
RETURNING (xmax = 0) AS is_new;
```

If `xmax = 0` the row was just inserted (true). If `xmax != 0` it was updated (false).

Update the TypeScript:

```ts
async upsertOnTeslaAuth(args: {
  userId: string; email: string | null; accessToken: string;
  refreshToken: string; tokenExpiresAt: number;
}): Promise<{ isNew: boolean }> {
  // ... existing query, with `, (xmax = 0) AS is_new` in RETURNING
  const res = await client.query<{ is_new: boolean }>(/* sql with RETURNING */);
  return { isNew: res.rows[0]?.is_new === true };
}
```

> If `upsertOnTeslaAuth`'s current shape differs significantly (e.g., it doesn't use `ON CONFLICT`), match the existing pattern and add the distinguishing check inline. Read the function first before editing.

- [ ] **Step 2: Use the result in the OAuth callback**

Open `cmd/next-app/src/app/auth/tesla-callback/route.ts`. Find the `await userRepo.upsertOnTeslaAuth(...)` call and capture the result:

```ts
const { isNew } = await userRepo.upsertOnTeslaAuth({
  userId,
  email: userEmail ?? null,
  accessToken: authData.access_token,
  refreshToken: authData.refresh_token,
  tokenExpiresAt: Date.now() + (authData.expires_in * 1000),
});
```

Then, at the redirect step at the bottom of the file, change:

```ts
if (savedCallback && savedCallback.startsWith('/') && !savedCallback.startsWith('//') && !savedCallback.startsWith('/\\')) {
    redirect(savedCallback);
} else {
    redirect('/');
}
```

to:

```ts
const target = (savedCallback && savedCallback.startsWith('/') && !savedCallback.startsWith('//') && !savedCallback.startsWith('/\\'))
    ? savedCallback
    : '/';
const sep = target.includes('?') ? '&' : '?';
redirect(`${target}${sep}login=success&new=${isNew ? '1' : '0'}`);
```

- [ ] **Step 3: Create the LoginSuccessTracker client component**

Create `cmd/next-app/src/components/LoginSuccessTracker.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { track } from '@/lib/analytics';

export function LoginSuccessTracker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get('login') !== 'success') return;
    const isNew = searchParams.get('new') === '1';
    track('tesla-login-success', { is_reauth: !isNew });

    // Strip the params so refreshes don't re-fire.
    const next = new URLSearchParams(searchParams.toString());
    next.delete('login');
    next.delete('new');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, pathname, router]);

  return null;
}
```

- [ ] **Step 4: Mount the tracker on possible landing pages**

Open `cmd/next-app/src/app/page.tsx`. Near the top, ensure the page is a client component or wraps a client tracker. If it's currently a server component, embed a small client child:

```tsx
import { LoginSuccessTracker } from '@/components/LoginSuccessTracker';
// ... existing imports

export default async function Page() {
  // ... existing server logic
  return (
    <>
      <LoginSuccessTracker />
      {/* existing JSX */}
    </>
  );
}
```

Repeat for `cmd/next-app/src/app/site/[id]/page.tsx`.

- [ ] **Step 5: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Verify existing tests still pass**

```bash
npm test -- src/lib/user-repo.test.ts
```

Expected: PASS. If they fail because of the new `{ isNew }` return type, update the test mocks to return `{ isNew: false }` from `upsertOnTeslaAuth`.

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/user-repo.ts cmd/next-app/src/app/auth/tesla-callback/route.ts cmd/next-app/src/components/LoginSuccessTracker.tsx cmd/next-app/src/app/page.tsx cmd/next-app/src/app/site/[id]/page.tsx
git commit -m "feat(analytics): fire tesla-login-success with is_reauth

upsertOnTeslaAuth now returns whether the user row was newly created.
The OAuth callback passes ?login=success&new=<0|1> on redirect.
LoginSuccessTracker reads the params client-side, fires the event,
and replaces the URL to prevent re-fires."
```

---

### Task 9: Wire `tesla-reauth-needed` at existing detection points

**Files:**
- Modify: `cmd/next-app/src/components/site/live/BatteryHoldCard.tsx`
- Modify: `cmd/next-app/src/components/SiteLiveStats.tsx`
- Modify: `cmd/next-app/src/components/HeaderLiveStats.tsx`
- Modify: `cmd/next-app/src/components/DashboardCards.tsx`

- [ ] **Step 1: In BatteryHoldCard, fire reauth event when status 409 + needs_reauth returns**

Open `cmd/next-app/src/components/site/live/BatteryHoldCard.tsx`. Find:

```ts
if (res.status === 409 && body?.error === 'needs_reauth') { setNeedsReauth(true); return { ok: false, body }; }
```

Add the import at the top:

```ts
import { notifyReauthNeeded } from '@/lib/reauth-signal';
```

Change the body of the condition to also notify:

```ts
if (res.status === 409 && body?.error === 'needs_reauth') {
  notifyReauthNeeded(siteId);
  setNeedsReauth(true);
  return { ok: false, body };
}
```

- [ ] **Step 2: In live-data fetchers, fire on 401**

Open `cmd/next-app/src/components/SiteLiveStats.tsx`. Add at top:

```ts
import { notifyReauthNeeded } from '@/lib/reauth-signal';
```

Find the catch block around `fetchSiteLiveData`. Where the component currently handles a fetch failure, add:

```ts
catch (err) {
  if (err instanceof SiteLiveDataFetchError && err.status === 401) {
    notifyReauthNeeded(siteId);
  }
  // ... existing handling
}
```

(If `SiteLiveDataFetchError` isn't already imported, add it.)

Repeat the same change in `cmd/next-app/src/components/HeaderLiveStats.tsx` and `cmd/next-app/src/components/DashboardCards.tsx` at each `fetchSiteLiveData` call site.

- [ ] **Step 3: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 4: Verify existing tests pass**

```bash
npm test
```

Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/live/BatteryHoldCard.tsx cmd/next-app/src/components/SiteLiveStats.tsx cmd/next-app/src/components/HeaderLiveStats.tsx cmd/next-app/src/components/DashboardCards.tsx
git commit -m "feat(analytics): fire tesla-reauth-needed at detection points

Notify reauth-signal helper when components encounter the existing
needs_reauth signal (battery-hold 409, live-data 401). Dedup in the
helper ensures a single event per page session."
```

---

### Task 10: Fire `site-loaded` and `site-tab-changed`

**Files:**
- Modify: `cmd/next-app/src/components/site/SiteTabs.tsx`

- [ ] **Step 1: Read the existing component**

Open `cmd/next-app/src/components/site/SiteTabs.tsx`. Identify (a) what data the component receives — specifically the `site_id` and any indicator of whether a battery hold is active, and (b) how tab clicks are wired.

- [ ] **Step 2: Add imports and fire events**

At the top of the component file add:

```ts
import { useEffect } from 'react';
import { track } from '@/lib/analytics';
```

Inside the component body (it's a client component), after props destructuring, add:

```tsx
useEffect(() => {
  track('site-loaded', {
    site_id: siteId,
    has_battery_hold: Boolean(activeHold),
  });
  // siteId/activeHold are stable for the lifetime of the page; intentionally
  // fire only on mount.
}, []);  // eslint-disable-line react-hooks/exhaustive-deps
```

> Adjust `activeHold` to whatever prop/state actually represents the hold presence — read the file and use the correct name. If the component doesn't currently receive that info, default to `false` and document a follow-up.

For each tab click handler, fire:

```tsx
track('site-tab-changed', { site_id: siteId, tab_name: tabName });
```

Where `tabName` is the tab being selected.

- [ ] **Step 3: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 4: Manual smoke (optional)**

In dev with Umami vars set, load `/site/<id>`, switch tabs, confirm events appear in Umami's events log.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/SiteTabs.tsx
git commit -m "feat(analytics): fire site-loaded and site-tab-changed events"
```

---

### Task 11: Fire battery-hold events + `qr-code-opened`

**Files:**
- Modify: `cmd/next-app/src/components/site/live/BatteryHoldCard.tsx`

- [ ] **Step 1: Add the import (if not already present from Task 9)**

```ts
import { track } from '@/lib/analytics';
```

- [ ] **Step 2: Fire `battery-hold-set` from the park flow**

In the `park()` function, after the successful `post({ action: 'park', ...choice })` and before `router.refresh()`, add:

```ts
track('battery-hold-set', {
  site_id: siteId,
  target_pct: typeof choice.target_pct === 'number' ? choice.target_pct : -1,
  hours: typeof choice.hours === 'number' ? choice.hours : -1,
});
```

> Confirm the exact field names on `HoldChoice` by reading `ConfirmHoldModal.tsx`. Adjust `target_pct` / `hours` to whatever the actual field names are. If a field is optional and undefined, omit it from the props instead of using `-1`.

- [ ] **Step 3: Fire `battery-hold-restored` from the restore flow**

In the `restore()` function, after the successful `post({ action: 'restore' })`:

```ts
track('battery-hold-restored', { site_id: siteId });
```

- [ ] **Step 4: Fire `qr-code-opened` when the QR modal opens**

Two onClick handlers open the QR modal:

```tsx
<Button variant="outline" size="sm" onClick={() => setShowQrModal(true)}>QR Code</Button>
```

Change them to:

```tsx
<Button
  variant="outline"
  size="sm"
  onClick={() => {
    track('qr-code-opened', { site_id: siteId });
    setShowQrModal(true);
  }}
>
  QR Code
</Button>
```

Replace both occurrences in the file.

- [ ] **Step 5: Verify build + lint + tests**

```bash
npm run lint
npm run build
npm test
```

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/components/site/live/BatteryHoldCard.tsx
git commit -m "feat(analytics): fire battery-hold-set/-restored and qr-code-opened"
```

---

### Task 12: Fire `tariffs-refreshed`

**Files:**
- Modify: `cmd/next-app/src/components/site/TariffList.tsx`

- [ ] **Step 1: Read TariffList to find the refresh handler**

Open the file. Find `onRefresh` — it's referenced on a button at line 35.

- [ ] **Step 2: Add the import and fire on click**

```ts
import { track } from '@/lib/analytics';
```

Find the call site (likely the `onRefresh` callback prop passed in, OR if there's a local handler that calls a prop, wrap that handler). Add the fire right before whatever existing logic runs:

```tsx
const handleRefresh = () => {
  track('tariffs-refreshed', { site_id: siteId });
  onRefresh();
};
```

Then pass `handleRefresh` to the button instead of `onRefresh`. If `siteId` isn't already in scope, get it from props (read the file to confirm prop shape).

- [ ] **Step 3: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/components/site/TariffList.tsx
git commit -m "feat(analytics): fire tariffs-refreshed event"
```

---

### Task 13: Fire `trmnl-install-success`, `trmnl-manage-viewed`, `trmnl-uninstall`

**Files:**
- Modify: TRMNL install client page (path determined during implementation — likely `cmd/next-app/src/app/trmnl/install/page.tsx` or a client child)
- Modify: TRMNL manage client page (same)

- [ ] **Step 1: Locate the TRMNL install success path**

```bash
ls cmd/next-app/src/app/trmnl/
grep -rn "install" cmd/next-app/src/app/trmnl/ --include="*.tsx" --include="*.ts" | head
```

Read the page. Find where a successful installation resolves (either after a server action, or after a fetch returns success).

- [ ] **Step 2: Fire `trmnl-install-success`**

Add to the relevant client component:

```ts
import { track } from '@/lib/analytics';
```

After the installation success path:

```ts
track('trmnl-install-success', { site_id: linkedSiteId });
```

(`linkedSiteId` = whatever variable holds the just-linked site id.)

- [ ] **Step 3: Locate the manage page**

Read `cmd/next-app/src/app/trmnl/manage/page.tsx` (or its client child).

- [ ] **Step 4: Fire `trmnl-manage-viewed` on mount and `trmnl-uninstall` on uninstall**

In the client component:

```ts
import { useEffect } from 'react';
import { track } from '@/lib/analytics';

// ... inside component
useEffect(() => {
  track('trmnl-manage-viewed', {
    site_id: siteId ?? '',
    has_installation: Boolean(installation),
  });
}, []);  // eslint-disable-line react-hooks/exhaustive-deps
```

At the uninstall confirm handler:

```ts
const onConfirmUninstall = async () => {
  track('trmnl-uninstall', { site_id: siteId });
  await /* existing uninstall logic */;
};
```

- [ ] **Step 5: Verify build + lint + tests**

```bash
npm run lint
npm run build
npm test
```

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/app/trmnl/
git commit -m "feat(analytics): fire trmnl-install-success/-manage-viewed/-uninstall"
```

---

### Task 14: Fire `load-analysis-tagged`

**Files:**
- Modify: `cmd/next-app/src/components/LoadAnalysisClientPage.tsx`

- [ ] **Step 1: Read the existing tag submit handler**

Open the file. Find the function that POSTs to `/api/site/${siteId}/analysis` with a tag payload (around line 205 per earlier exploration).

- [ ] **Step 2: Add the import and fire**

```ts
import { track } from '@/lib/analytics';
```

In the tag submission handler, right after a successful response, fire:

```ts
track('load-analysis-tagged', { site_id: siteId, tag: tagName });
```

Where `tagName` is the tag the user submitted. Confirm the variable name by reading the function.

- [ ] **Step 3: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/components/LoadAnalysisClientPage.tsx
git commit -m "feat(analytics): fire load-analysis-tagged event"
```

---

### Task 15: Full Phase-2 smoke check

- [ ] **Step 1: Run full suite**

```bash
cd cmd/next-app
npm run lint
npm run build
npm test
```

All must pass.

- [ ] **Step 2: Catalog all event call sites**

```bash
grep -rn "track('" src --include="*.ts" --include="*.tsx"
```

Confirm exactly 12 distinct event names appear:

- `tesla-login-success`
- `tesla-reauth-needed`
- `site-loaded`
- `site-tab-changed`
- `battery-hold-set`
- `battery-hold-restored`
- `tariffs-refreshed`
- `trmnl-install-success`
- `trmnl-manage-viewed`
- `trmnl-uninstall`
- `load-analysis-tagged`
- `qr-code-opened`

If any are missing, locate the relevant task and complete it. If any extra event names appear, evaluate whether they're intentional (and if so, document them).

---

## Phase 3: Better Stack log migration (Tasks 16–21)

Swap `console.*` → `log.*` in the eight target files. Preserve the existing `[ComponentName]` message prefixes so log-based search patterns don't break. Audit for accidentally-logged secrets during each migration. Apply `withLog` to the four route-handler files.

### Task 16: Migrate `tesla-client.ts`

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-client.ts`

- [ ] **Step 1: Add the import**

At the top:

```ts
import { log } from './log';
```

- [ ] **Step 2: Swap each `console.*` call**

Replace every `console.log(...)` with `log.info(...)`, `console.warn(...)` with `log.warn(...)`, `console.error(...)` with `log.error(...)`. Preserve the existing message strings exactly.

Where the existing call passes a second argument that is an object, keep it (it becomes the `ctx`). Where it passes a non-object second argument (e.g., a string), wrap it:

```ts
// before
console.error('Token refresh failed:', refreshError);
// after
log.error('Token refresh failed', { err: refreshError instanceof Error ? refreshError.message : String(refreshError) });
```

Audit each call: if any logs include a token, refresh token, secret, or full Tesla API response with a token field, **redact** before this migration. Replace with a length or last-4-chars indicator.

- [ ] **Step 3: Run focused tests**

```bash
npm test -- src/lib/tesla-client
```

Expected: PASS.

- [ ] **Step 4: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/tesla-client.ts
git commit -m "refactor(log): migrate tesla-client to log.* wrapper

Routes log lines through Better Stack while preserving console.* for
local visibility. Existing message prefixes preserved to keep
log-based searches and alerts working."
```

---

### Task 17: Migrate `tesla-token-repo.ts` and `user-repo.ts`

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-token-repo.ts`
- Modify: `cmd/next-app/src/lib/user-repo.ts`

- [ ] **Step 1: Apply the same migration pattern as Task 16**

For each file:

```ts
import { log } from './log';
```

Swap every `console.*` to its `log.*` equivalent. Preserve `[TokenLock]`, `[TeslaTokenRepo]`, `[UserRepo]` message prefixes. In particular, ensure the line:

```ts
console.warn(`[TokenLock] Terminal auth failure for site ${siteId} (User ${site.user_id}). Revoking and releasing lock atomically.`);
```

becomes:

```ts
log.warn(`[TokenLock] Terminal auth failure for site ${siteId} (User ${site.user_id}). Revoking and releasing lock atomically.`, {
  site_id: siteId,
  user_id: site.user_id,
});
```

The structured `site_id`/`user_id` context makes the Better Stack log-based alert filterable. **This specific line is what the "Tesla auth wall" alert in the spec keys on.**

Audit for token logging. If `console.*` lines log raw `accessToken` or `refreshToken`, redact during the swap.

- [ ] **Step 2: Run focused tests**

```bash
npm test -- src/lib/tesla-token-repo src/lib/user-repo
```

- [ ] **Step 3: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/lib/tesla-token-repo.ts cmd/next-app/src/lib/user-repo.ts
git commit -m "refactor(log): migrate tesla-token-repo and user-repo to log.*

Token-lock and user-status messages now ship structured site_id and
user_id context to Better Stack. The TokenLock Terminal-auth-failure
line keeps its exact prefix so the planned log-based alert matches."
```

---

### Task 18: Migrate `battery-hold-service.ts`

**Files:**
- Modify: `cmd/next-app/src/lib/battery-hold-service.ts`

- [ ] **Step 1: Apply the migration pattern**

Add `import { log } from './log';`, swap `console.*` for `log.*`, preserve `[BatteryHold]` prefixes and pass structured context (site_id, target, error message) where applicable.

- [ ] **Step 2: Run focused tests**

```bash
npm test -- src/lib/battery-hold-service
```

- [ ] **Step 3: Verify build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/lib/battery-hold-service.ts
git commit -m "refactor(log): migrate battery-hold-service to log.*"
```

---

### Task 19: Migrate cron routes + apply `withLog` + heartbeats

**Files:**
- Modify: `cmd/next-app/src/app/api/cron/cleanup/route.ts`
- Modify: `cmd/next-app/src/app/api/cron/check-users/route.ts`
- Modify: `cmd/next-app/src/app/api/cron/restore-reserve/route.ts`

- [ ] **Step 1: cleanup cron**

Open `cmd/next-app/src/app/api/cron/cleanup/route.ts`. Replace its contents (preserving business logic) with:

```ts
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { LoadTagRepo } from '@/lib/load-tag-repo';
import { log } from '@/lib/log';
import { withLog } from '@/lib/with-log';
import { pingHeartbeat } from '@/lib/heartbeat';

export const GET = withLog(async (request: NextRequest) => {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || '365', 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const energyRepo = new EnergyRepo();
    const tagRepo = new LoadTagRepo();
    const energyResult = await energyRepo.cleanupOldEnergyData(cutoff);
    const tagResult = await tagRepo.cleanupOldTags(cutoff);

    const result = {
      energyDeleted: energyResult.energyDeleted,
      tagsDeleted: tagResult.tagsDeleted,
    };

    log.info(`[CRON] Cleanup completed. Cutoff: ${cutoff.toISOString()}. Deleted: ${JSON.stringify(result)}`, {
      cutoff: cutoff.toISOString(),
      ...result,
    });

    await pingHeartbeat('cleanup');

    return NextResponse.json({
      success: true,
      retentionDays,
      cutoff: cutoff.toISOString(),
      deleted: result,
    });
  } catch (error) {
    log.error('[CRON] Cleanup failed', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
});
```

- [ ] **Step 2: check-users cron**

Read `cmd/next-app/src/app/api/cron/check-users/route.ts` first. Apply the same pattern: import `log`, `withLog`, `pingHeartbeat`; wrap with `withLog`; swap `console.*` for `log.*` preserving prefixes; call `pingHeartbeat('check-users')` after success.

- [ ] **Step 3: restore-reserve cron**

Read `cmd/next-app/src/app/api/cron/restore-reserve/route.ts`. Apply the same pattern.

The single existing log line:

```ts
console.log(`[CRON] restore-reserve processed ${holds.length} hold(s): ${JSON.stringify(results)}`);
```

becomes:

```ts
log.info(`[CRON] restore-reserve processed ${holds.length} hold(s): ${JSON.stringify(results)}`, {
  processed: holds.length,
  results,
});
```

Call `pingHeartbeat('restore-reserve')` after the log.info, before the response.

- [ ] **Step 4: Verify build + lint + tests**

```bash
npm run lint
npm run build
npm test
```

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/api/cron/cleanup/route.ts cmd/next-app/src/app/api/cron/check-users/route.ts cmd/next-app/src/app/api/cron/restore-reserve/route.ts
git commit -m "refactor(log): migrate cron routes; add withLog + heartbeats

All three crons now ship logs to Better Stack via log.* (with flush
on response) and POST to per-cron heartbeat URLs on successful
completion. Heartbeat failure is swallowed so it can never break
the cron."
```

---

### Task 20: Migrate `/api/trmnl/markup`

**Files:**
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.ts`

- [ ] **Step 1: Read the current file**

```bash
cat cmd/next-app/src/app/api/trmnl/markup/route.ts
```

- [ ] **Step 2: Apply the route migration pattern**

Imports:

```ts
import { log } from '@/lib/log';
import { withLog } from '@/lib/with-log';
```

Wrap each exported handler with `withLog`:

```ts
export const GET = withLog(async (req: NextRequest, ctx) => {
  // ... existing body
});
```

Swap `console.*` for `log.*` preserving prefixes (TRMNL-renderer messages, freshness/debug header logs, etc.). Pass structured context where the existing call did string concatenation.

- [ ] **Step 3: Verify build + lint + tests**

```bash
npm run lint
npm run build
npm test
```

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/app/api/trmnl/markup/route.ts
git commit -m "refactor(log): migrate /api/trmnl/markup to log.* + withLog"
```

---

### Task 21: Verify migration completeness

- [ ] **Step 1: Confirm no `console.*` remains in the eight migrated files**

```bash
cd cmd/next-app
for f in \
  src/lib/tesla-client.ts \
  src/lib/tesla-token-repo.ts \
  src/lib/user-repo.ts \
  src/lib/battery-hold-service.ts \
  src/app/api/cron/cleanup/route.ts \
  src/app/api/cron/check-users/route.ts \
  src/app/api/cron/restore-reserve/route.ts \
  src/app/api/trmnl/markup/route.ts; do
  echo "=== $f ==="
  grep -n "console\." "$f" || echo "  (clean)"
done
```

Expected: every file reports `(clean)`. If any `console.*` remains, fix it before moving on.

- [ ] **Step 2: Confirm `console.*` outside the eight files is untouched (sanity check)**

```bash
grep -rn "console\." src --include="*.ts" --include="*.tsx" | wc -l
```

Expected: roughly 167 minus the count that was in the eight files. (Read pre-migration count from `git log` if curious; the absolute number isn't important — the point is that we didn't accidentally migrate extras.)

- [ ] **Step 3: Full suite green**

```bash
npm run lint
npm run build
npm test
```

All must pass.

- [ ] **Step 4: Commit any cleanup**

If steps 1–3 produced any small fixes, commit them:

```bash
git add -p
git commit -m "chore(log): cleanup leftover console.* in migrated files"
```

---

## Phase 4: Finishing touches (Task 22)

### Task 22: External configuration checklist (out-of-code; user executes)

This task lists the configuration steps that happen outside the codebase. **Do not skip.** They turn the wiring on. The plan executor should produce a checklist comment in the PR description summarizing these.

- [ ] **Step 1: Vercel environment variables**

In the Vercel dashboard for the production project:

1. **Settings → Environment Variables**, **Production scope**, add:
   - `NEXT_PUBLIC_UMAMI_SCRIPT_URL=https://cloud.umami.is/script.js`
   - `NEXT_PUBLIC_UMAMI_WEBSITE_ID=947f4b6f-4f72-4ef6-a7b2-dff8dd0b49d0` (Kevin's website id)
   - `BETTERSTACK_SOURCE_TOKEN=<from-Better-Stack-Sources>`
   - `BETTERSTACK_INGEST_URL=<from-Better-Stack-Sources>`
   - `BETTERSTACK_HEARTBEAT_CLEANUP=<from-Better-Stack-Uptime>`
   - `BETTERSTACK_HEARTBEAT_CHECK_USERS=<from-Better-Stack-Uptime>`
   - `BETTERSTACK_HEARTBEAT_RESTORE_RESERVE=<from-Better-Stack-Uptime>`
2. Confirm none are added to Preview or Development scopes.

- [ ] **Step 2: Create Better Stack heartbeats**

In Better Stack **Uptime → Heartbeats → Create heartbeat**, create three:

| Name | Period | Grace |
|---|---|---|
| pwusage cleanup | 24 hours | 1 hour |
| pwusage check-users | 24 hours | 1 hour |
| pwusage restore-reserve | (read from `vercel.json` once Supabase cron is wired; if it runs every 5 min, set 5 min + 5 min grace) | varies |

Copy each heartbeat's POST URL into the corresponding Vercel env var.

> If the user has notification routing to Slack from Better Stack, also create an Incident policy that pings Slack on missed heartbeat.

- [ ] **Step 3: Create Better Stack log-based alerts**

In Better Stack **Telemetry → Alerts → Create alert**:

1. **Tesla auth wall** — query for log messages matching `Terminal auth failure for site`. Trigger when count > 3 over 1 hour. Notify Slack.
2. **Cron error logs** — query for `error`-level log lines where the source path contains `/api/cron/`. Trigger immediately. Notify Slack.

(Exact query syntax depends on Better Stack's current UI. Save both as named alerts.)

- [ ] **Step 4: Deploy + verify**

After the PR merges:

1. Visit production. Open browser devtools → Network. Confirm `script.js` from `cloud.umami.is` loads.
2. In Umami dashboard, confirm a pageview appears for your visit.
3. Trigger one cron manually (Vercel **Crons → Trigger**) and confirm:
   - A log line appears in Better Stack within ~10s.
   - The corresponding heartbeat shows as recently received in Better Stack.
4. Trigger `site-tab-changed` by clicking a tab and confirm it appears in Umami's events log.

If any step fails, debug before considering the project complete.

- [ ] **Step 5: Update TODO.md**

Append to `TODO.md`:

```markdown
- [ ] Migrate remaining ~130 `console.*` callsites to `log.*` for full Better Stack coverage (low-priority follow-up to the Umami + Better Stack project).
- [ ] Enrich `getCurrentUser()` to also return `email` so `AnalyticsIdentify` can pass it (current call passes `null`).
```

- [ ] **Step 6: Final commit (TODO + any pending cleanup)**

```bash
git add cmd/next-app/TODO.md
git commit -m "chore: capture observability follow-ups in TODO.md"
```

---

## Acceptance criteria (from the spec)

Verify all of these before marking the project complete:

- [ ] Visiting production logs a pageview in Umami.
- [ ] All 12 events fire from their documented locations (smoke check via Umami's live event view).
- [ ] `identify()` fires after Tesla login; subsequent events appear attributed to that user.
- [ ] A log line from one of the eight migrated files appears in Better Stack within ~10s of the request.
- [ ] A real (or simulated) cron failure triggers a Better Stack heartbeat alert.
- [ ] `npm run dev` and `npm test` produce no network traffic to Umami or Better Stack.
- [ ] `npm run lint`, `npm run build`, `npm test` all pass on the final commit.

---

## Self-review notes

Reviewed for spec coverage, placeholders, type consistency. Findings:

- Every spec section maps to at least one task (file structure → T1–T6; Umami architecture → T7–T15; Better Stack architecture → T2, T16–T21; Heartbeats → T4, T19; Env vars → T6, T22; Privacy/testing → covered by per-task test steps; Local dev/test no-op behavior → asserted in T1–T5 tests).
- Three task descriptions reference reading the existing file to confirm field/prop names (`SiteTabs.tsx`, `HoldChoice` in `BatteryHoldCard.tsx`, TRMNL install/manage paths). This is intentional rather than a placeholder — the code is being read as part of the step, not deferred.
- Type consistency: `log.{info,warn,error,debug}` signatures are consistent across all uses; `withLog`'s `Handler<Ctx>` shape matches the Next.js route handler signature; `HeartbeatName` union matches the three heartbeat env var names.
- One known soft spot: Task 7 passes `email: null` because `getCurrentUser` does not yet expose email. This is captured as a TODO in Task 22. Not a plan defect.
