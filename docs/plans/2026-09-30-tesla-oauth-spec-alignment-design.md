# Tesla OAuth Spec Alignment — Design

**Date:** 2026-09-30
**Status:** Implemented (2026-09-30) — see the
[implementation plan](../superpowers/plans/2026-09-30-tesla-oauth-spec-alignment.md)
**Origin:** Investigation into "authenticating using a Tesla API passkey"

The "Deviation" sections below are deliberately left in their original **pre-fix**
form. They record what was wrong and why, so their `file:line` references (some of
which have since drifted) are historical record, not a description of current
behavior. Current behavior is documented in `Authentication.md` and
`DesignDecisions.md` §5.

---

## Background

The task that produced this document was to make pwusage authenticate via a
"Tesla API passkey". The investigation concluded that **no such integration
exists and none was needed** — but it surfaced several genuine deviations from
Tesla's Fleet API documentation in our OAuth implementation. This document
covers fixing those.

### Passkey investigation outcome

Tesla's Fleet API has no passkey concept. Its third-party OIDC configuration
advertises only `grant_types_supported: ["authorization_code"]`,
`token_endpoint_auth_methods_supported: ["client_secret_post"]`, and no
`code_challenge_methods_supported`. What Tesla shipped in August 2026 is passkey
as an **account sign-in credential** on `auth.tesla.com`, replacing the password
in "Sign in with Tesla".

A passkey user reported "passkey failed" inside `auth.tesla.com`. Root cause:
the user's passkey had been saved by a password manager but **never enrolled
through Tesla's own account security page**, so Tesla's server held no matching
public key and rejected a cryptographically valid assertion. After enrolling via
`accounts.tesla.com/account-settings/security`, sign-in worked on both web and
iOS with no code change.

Ruled out along the way, each by direct experiment:

- `prompt=login` — posted the real step-init endpoint with and without it;
  `next_steps` was identical.
- The mobile PKCE handoff and `ASWebAuthenticationSession`.
- OAuth flow health generally — password + MFA succeeded on all authorize URLs.

Follow-up worth doing separately: the failure mode is indistinguishable from a
broken app, so `/login` may warrant a short passkey troubleshooting hint.

---

## Verified findings

All values below were confirmed against live Tesla endpoints on 2026-09-30.

### Issuer → JWKS mapping

OIDC discovery is per-issuer and the two Tesla issuers use **different key
sets**:

| Issuer | Discovered `jwks_uri` |
|---|---|
| `https://auth.tesla.com/oauth2/v3/nts` | `.../v3/discovery/thirdparty/keys` |
| `https://auth.tesla.com/oauth2/v3` | `.../v3/discovery/keys` |

Tesla issues `/nts` ID tokens — that is what the third-party discovery document
declares as `issuer`.

### Deviation 1 — fallback JWKS URI points at the wrong key set

`getTeslaJwksUri` (`src/lib/tesla-auth-service.ts:32-67`) discovers correctly, but
its hardcoded fallback is `.../v3/discovery/keys`. That is correct for the base
`/v3` issuer and **wrong for `/nts`**.

Consequence: any transient discovery failure resolves the wrong key set, the
`kid` is not found, and `KidNotFoundError` routes into the degraded path that
**bypasses ID token signature verification** (`tesla-auth-service.ts:336`). A
network blip silently downgrades authentication strength.

### Deviation 2 — hand-rolled JWKS refresh is redundant and unbounded

`getTeslaSigningKeyWithIssuer` (`tesla-auth-service.ts:120-180`) hand-rolls a
"lazy refresh" via raw `fetch` on an unknown `kid`.

Reading jwks-rsa v4.1.0's source (`src/JwksClient.js`, `src/wrappers/cache.js`)
shows this is unnecessary. The wrapper pipeline is:

```
callbackSupport( rateLimit( cacheSigningKey( JwksClient.getSigningKey ) ) )
```

`cacheSigningKey` memoizes **per `kid`** via `lru-memoizer` with
`ttl: cacheMaxAge`. There is **no second-level cache of the key set**. A `kid`
miss falls straight through to `JwksClient.getKeys()`, which performs a fresh
HTTP fetch — wrapped by `rateLimitSigningKey`.

So jwks-rsa already refetches on an unknown `kid`. Our manual refresh:

- is redundant with behaviour the library provides,
- bypasses the library's rate limiter (raw `fetch` per unknown `kid` — a request
  amplification vector against Tesla),
- reads the module-level `teslaJwksUri`, which is the possibly-wrong URI, so it
  cannot self-heal.

### Deviation 3 — 3s verification timeout hard-fails login

`tesla-auth-service.ts:315-327` races `verifyTeslaIdToken` against a 3-second
timeout. A cold path performs two sequential network round-trips (OIDC discovery
then JWKS). On a cold serverless instance this is easily exceeded. The timeout
throws a plain `Error`, so `isKidNotFound` is `false` and the callback returns
`invalid-id-token`. No retry, no distinction between "Tesla was slow" and
"token is invalid".

### Deviation 4 — token endpoint host

Tesla's third-party docs state calls to `/token` **must** use
`https://fleet-auth.prd.vn.cloud.tesla.com`, since server-to-server calls carry
different rate limits. We post to `https://auth.tesla.com/oauth2/v3/token` in
both `tesla-auth-service.ts:285` and `tesla-auth.ts:4`.

Both hosts are currently live and correctly routed for third-party exchange —
verified by observing an identical `client_not_found` response from each. Note
the OIDC discovery document still *declares* `auth.tesla.com`, so Tesla's own
documentation is internally inconsistent and a fallback is the honest response.

### Deviation 5 — refresh request is malformed

`refreshAccessToken` (`src/lib/tesla-auth.ts:3-19`):

- omits `audience`, which Tesla documents as required for token requests,
- sends `application/json` while the code exchange uses form encoding,
- defaults `client_id` to the literal `'ownerapi'` when
  `PUBLIC_TESLA_OAUTH_CLIENT_ID` is unset — which would present our
  `client_secret` to the first-party Owner API.

### Deviation 6 — `prompt=login` (cosmetic / minor)

`prompt=login` appears in Tesla's own authorize example, so it is not a
deviation. But it force-reauthenticates on every login when its actual purpose —
picking up newly-granted scopes — has a purpose-built parameter,
`prompt_missing_scopes=true`, per Tesla's documented scope-addition guidance.
`Authentication.md:64-67` records the `prompt=login` dependency.

Also: a stray `?&` in the authorize URL (`login/route.ts:47`).

---

## Design

### 1. Issuer-aware JWKS resolution

Replace the hardcoded fallback with a mapping that mirrors discovery, defaulting
to the `thirdparty` set since that is what Tesla issues:

```
/nts  -> https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys
base  -> https://auth.tesla.com/oauth2/v3/discovery/keys
```

Unknown issuers fall back to the `thirdparty` set. This removes the
wrong-key-set path entirely rather than narrowing when it can trigger.

### 2. Delete the hand-rolled lazy refresh

Remove `fetchFreshJwks`-on-unknown-`kid` and rely on jwks-rsa's built-in
refetch-on-miss. Retain a single `KidNotFoundError` raised when the library
reports `SigningKeyNotFoundError`, so the degraded path keeps its trigger.

Set `jwksRequestsPerMinute` explicitly rather than relying on the default, and
set `timeout` deliberately.

### 3. Availability during a JWKS outage — without silent downgrade

Opt into `cacheMaxAgeFallback` and wire `onStaleCacheFallback` to log loudly.
This keeps logins working through a transient Tesla JWKS outage while making the
event observable, replacing today's behaviour where a JWKS problem silently
downgraded signature verification.

`cacheMaxAgeFallback` is explicitly documented upstream as an availability vs.
security trade-off (a compromised key stays trusted for that window). The window
must be set to Tesla's expected recovery time, not chosen arbitrarily.

### 4. Cache OIDC discovery per issuer

Cache the resolved JWKS URI per issuer in module scope with a TTL. Steady-state
logins then skip the discovery round-trip, which removes most of the latency
that Deviation 3 is about.

### 5. Timeout only the cold path

Replace the blanket 3-second race. Apply a bounded timeout only when a network
fetch is genuinely required (cold cache); skip the race when the key is already
cached, since a cache hit is local and cannot hang. On timeout, fail with a
distinct, logged error rather than mislabelling it `invalid-id-token`.

### 6. Token endpoint with fallback

Prefer `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`, falling back
to `auth.tesla.com` on network failure or 5xx only. A 4xx is a real
authentication failure and must not be retried against another host.

### 7. Fix the refresh call

Add `audience`, switch to form encoding to match the code exchange, remove the
`'ownerapi'` default, and fail loudly if the client id is unset.

### 8. Authorize parameters

Replace `prompt=login` with `prompt_missing_scopes=true`, preserving the scope
pickup behaviour documented in `Authentication.md`. Fix the stray `?&`.

`require_requested_scopes` is deliberately **not** added: it could not be
verified (probes returned Akamai `403`s interleaved with `200`s, i.e. bot-scoring
noise rather than parameter rejection).

---

## Error handling

| Condition | Outcome |
|---|---|
| Discovery fails, cached URI valid | Use cached URI; log warn |
| Discovery fails, no cache | Issuer-aware fallback; log error |
| Unknown `kid`, endpoint reachable | jwks-rsa refetches; if still absent → `KidNotFoundError` |
| Unknown `kid`, endpoint down, within stale window | Serve stale key; `onStaleCacheFallback` logs |
| Unknown `kid`, endpoint down, window expired | Hard fail, logged — **never** a silent downgrade |
| Cold-path network timeout | Distinct logged error, not `invalid-id-token` |
| Token 5xx / network error | Fall back to secondary host |
| Token 4xx | Fail as auth error; do not retry |
| Missing client id / secret | Fail loudly at call site |

---

## Testing

Repo convention is Vitest with colocated tests;
`src/lib/tesla-auth-service.test.ts` already exists (~1000 lines) and provides
the DI seams (`tokenExchange`, `verifyIdToken`) needed.

New cases:

1. Fallback JWKS URI is issuer-aware — `/nts` resolves to `thirdparty/keys`,
   base `/v3` to `discovery/keys`, unknown issuer to `thirdparty/keys`.
2. No manual JWKS refetch remains on unknown `kid`; a single library call is made
   and repeated misses do not amplify requests.
3. Degraded path refuses when the JWKS endpoint is unavailable, and refuses when
   discovery failed and no valid cache existed.
4. Warm-cache verification is not subject to the timeout race.
5. Cold-path timeout yields a distinct error, not `invalid-id-token`.
6. Token exchange prefers the `fleet-auth` host; falls back on 5xx; does **not**
   fall back on 4xx.
7. Refresh request includes `audience`, uses form encoding, and never sends
   `ownerapi` — fails loudly when the client id is unset.
8. Authorize URL contains `prompt_missing_scopes=true` and no stray `?&`.

`npm test`, `npm run lint`, and `npm run build` must all pass.

---

## Risks

All changes are in the authentication path.

- **Highest:** items 1–3 change how ID tokens are verified. A regression locks
  out all logins. Mitigated by tests 1–5 and a staging verification with both a
  fresh and an existing account.
- **`cacheMaxAgeFallback` window** is a deliberate security/availability trade.
  Needs a defensible value and an alerting path, not an arbitrary one.
- **Token host switch** — verified both hosts respond, but ordering and
  fallback should be exercised on staging before production.
- **`prompt_missing_scopes`** is the only user-visible change. Verify on staging
  with an account that has not granted all scopes.

---

## Out of scope

- Any attempt to "implement passkey support" — it is not a Fleet API feature.
- The `/login` passkey troubleshooting hint (worthwhile, separate).
- Netzero's 2.6.8 change remains publicly undocumented; not required, since our
  flow is verified working.
