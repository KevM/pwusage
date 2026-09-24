# iOS Widget Authorization Design

## Decision

Future PWUsage widgets will use the existing `site_auth` session issued to the iOS app. The login handoff in PR #110 remains a short-lived, single-use bootstrap; widgets neither read nor redeem `MobileLoginHandoff` rows. The app and its future widget extension will use an App Group cookie store so their `URLSession` requests send the same HTTP-only `site_auth` cookie to the existing site-scoped APIs. No widget-specific long-lived token or Tesla credential is introduced.

This supports three read-only views (battery SoC, car-charge bill-impact advice, and current monthly bill) and an authenticated interactive action to start an automatic battery hold. The advice is informational; the hold action is a Tesla reserve write and has stronger checks.

## Credential lifecycle

1. The iOS app completes the existing Tesla login and mobile PKCE handoff. `/api/mobile/session` sets `site_auth` on the app's own `URLSession` response.
2. The app target and future widget target receive the same App Group entitlement and configure `URLSession` with `HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier:)`. The widget does not open a second login or copy a JWT into `UserDefaults`.
3. The browser authentication sheet still has a separate cookie store. Its cookies are irrelevant after the handoff.
4. The server's existing proxy may renew `site_auth` on an authorized request. The shared cookie store receives `Set-Cookie`, so app and widget see the renewed session. If the session expires or reaches its absolute limit, the widget directs the user to open the app and sign in; it cannot silently reauthenticate with Tesla.
5. Logout and invalid-session handling clear the shared cookie and any per-site cached widget snapshots. A snapshot is presentation data, never an authorization credential. A widget fetch always sends its configured site ID to the server, where authorization is checked again.

The current app uses `HTTPCookieStorage.shared`, which is private to its process/container. Changing to an App Group store before shipping a widget requires an entitlement in both targets and a one-time transition for already-signed-in users: either migrate the current cookie securely or require sign-in again. Configuring the shared store before the first app release avoids that transition. Provisioning for the App Group must be verified in signed device builds.

## Read-only requests

The widget uses the existing cookie with `/api/site-live-data?view=mobile` and `/api/mobile/bill-summary`. Both routes require site authorization. Before serving private data, the server must verify that the user is active and is **currently** assigned to the requested site (or currently has an admin role). Today `verifySiteAccess` checks active status but takes site IDs and admin role from JWT claims; those claims may remain valid after an assignment or role is removed. This current-access check is a prerequisite for widget reads as well as writes. Responses carry source timestamps; a widget must not describe a stale battery reading as live merely because WidgetKit refreshed its timeline. If a request fails, it may show a site-scoped cached value with its original measurement time only while the session and current site access remain valid. A missing or revoked session hides private values and offers an open-app sign-in action.

The car-charge bill-impact calculation should remain on the server and use the same tariff and billing rules as the website. It should be exposed through a compact mobile contract when that widget is implemented. It is not a reason to grant the widget Tesla tokens or to broaden the session cookie.

## Battery-hold write

The widget's `Hold battery` button will run an App Intent in automatic mode. Set its authentication policy to require authentication on the local device before the command. Local authentication prevents an unintended action from a locked device; the server must independently authorize every request.

Before calling Tesla, the server must verify a valid `site_auth` session, an active user, the user's **current** assignment to the requested site (or current admin role), and usable Tesla command permission. It must not rely solely on the site IDs and roles embedded in a still-valid JWT, because those claims may predate a site removal or role change. The write route should reject cross-origin browser requests when an `Origin` or Fetch Metadata header is present, while permitting native `URLSession` requests that omit those headers.

The server obtains fresh SoC and reserve state and applies the existing `planReserve` rules. At 85–95% SoC, the action returns `needs_choice`; the widget opens the app for an explicit 80% versus 100% choice. It never decides from a cached widget reading. A repeated or concurrent tap must not issue a second conflicting Tesla command. Serialize or idempotently claim one hold operation per site before the first Tesla write. The existing automatic restore job, including its eight-hour backstop, remains responsible for ending the hold; widget refresh timing has no safety role.

The widget displays the confirmed server result and active hold state, not an optimistic success. Expired session, removed site access, missing command permission, ambiguous reserve, unavailable SoC, and an in-progress hold receive distinct outcomes. A future `Restore now` widget control would use the same local authentication and current server authorization.

## Alternatives considered

- **Shared Keychain bearer token:** possible, but it adds token extraction, a second transport convention, and renewal/logout synchronization while the server already authorizes `site_auth` cookies.
- **Read-only widget token plus a separate write token:** offers narrower credentials but adds issuance, rotation, revocation, and a second authorization model. Reconsider if widgets become independently distributed or require materially different permissions.
- **App-written snapshots only:** keeps credentials out of the extension but cannot fetch current values or start a hold when the app is closed, contrary to the intended behavior.

## Implementation boundary

This document is an authorization architecture, not an instruction to build widgets now. PR #110 can keep its handoff table and API unchanged. Before shipping widget functionality, implement and verify the shared cookie store, session migration or re-login behavior, logout/cache clearing, current-site checks for writes, concurrency protection for the hold command, and device tests for the extension's cookie and App Intent behavior.
