# Shared Powerwall sites: several Tesla accounts on one site

- **Date:** 2026-11-08
- **Status:** Draft for owner review. Phase 0 (Tesla tests) gates everything after it.
- **Area:** `cmd/next-app` (schema, auth, token selection), small changes in `cmd/ios-app`
- **Related:** [account deletion PR KevM/pwusage#319](https://github.com/KevM/pwusage/pull/319), [`Authentication.md`](../../../Authentication.md), [`DesignDecisions.md`](../../../DesignDecisions.md)

## 1. Summary

`Site.user_id` means two things today: who may see the site, and whose Tesla grant reads it. Each
Tesla login overwrites it (`src/lib/tesla-auth-service.ts:833`), so the last person to sign in takes
the site and everyone else loses access until they sign in again.

Recommendations:

1. **Split the two meanings.** A new `SiteMember` table says who may access a site. A new
   `Site.tesla_connection_user_id` column says whose grant background work uses. A foreign key makes
   sure the connection user is always a member.
2. **Tesla decides membership.** You become a member when your own `getProducts()` lists the site and
   stop being one when it no longer does. There is no in-app invite and no pwusage owner role.
3. **Reads and writes use different tokens.** Reads and background refreshes use the site's
   connection user. A person's own write uses that person's own token, so pwusage never gives someone
   a permission Tesla denied them. A Battery Saver restore is the one exception: it may use any member
   who can send commands, so it can't get stranded.
4. **Account deletion removes a membership.** The site goes only when its last member leaves. This
   changes PR #319's `Site.user_id ON DELETE CASCADE`, which would otherwise delete a site out from
   under its other members.
5. **Run the Tesla tests before building anything** (section 3). Tesla's docs do not say what an
   invited account's API token can do, and one third-party source suggests shared users may not work.

Decisions the owner needs to make are in [section 11](#11-open-questions-for-the-owner).

## 2. Goals and non-goals

**Goals**

- Two people on one Powerwall can both use pwusage at the same time, on web, iOS and TRMNL.
- Signing in never takes anything away from another member.
- Data keeps updating, and Battery Saver still restores, if one member loses their Tesla connection.
- Someone removed from the site in Tesla loses pwusage access without anyone acting in pwusage.

**Non-goals**

- In-app invitations, roles or an owner concept. Tesla's Manage Access screen stays the only control.
- A "leave site" button. Tesla would list the site again at the next login and silently undo it.
  Leaving means being removed in Tesla, or deleting your account.
- Per-member rate plans, tags or display settings (section 7).

**Failure even if it works technically**

- A person can do something through pwusage that Tesla does not let their account do.
- A former member, or the previous owner of a sold home, keeps seeing live data.
- A failover copies or shares a Tesla grant. Each grant must have exactly one holder
  (`DesignDecisions.md`, "The one precondition").

## 3. Tesla behaviour

Checked on 2026-11-08. The docs below settle less than the design needs.

| Question | What the sources say | Status |
| --- | --- | --- |
| Can an owner add another Tesla account? | Yes: Settings, Manage Access, Add Member. "If you add a user, that user will have access to all the Tesla app features for your energy system." ([Tesla support](https://www.tesla.com/support/energy/powerwall/mobile-app/manage-access-energy-system)) | Confirmed, for the Tesla **app** only |
| Is the site in the invitee's `GET /api/1/products`? | "Returns products mapped to user." Sharing is not mentioned. ([energy endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/energy)) | **Not documented** |
| Can the invitee's token read the site? | `energy_device_data` covers live status, site info and history. Nothing separates owners from shared users. ([auth overview](https://developer.tesla.com/docs/fleet-api/authentication/overview)) | **Not documented** |
| Can the invitee's token change backup reserve? | `energy_cmds` covers "settings like backup reserve percent". The endpoint lists no role requirement, and the only shared-user rule on the page is about vehicles. | **Not documented** |
| What does Fleet API say about non-owners? | Customer products are reached by "having the product owner go through the authorization flow". This answers an installer question and doesn't address invited users. ([FAQ](https://developer.tesla.com/docs/fleet-api/support/faq)) | Ambiguous, a caution |
| Third-party experience | GridMind's troubleshooting for "Site not found": "Ensure your Tesla account is the primary account on the Powerwall (not a shared user)." ([GridMind](https://gridmind-cloud.pages.dev/docs/integrations/tesla)) | Weak evidence **against**, unverified |
| Do grants last if unused? | Refresh tokens are single use and expire after 3 months. ([third-party tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens)) | Confirmed; affects standby members (section 6.5) |

So the app's behaviour suggests this will work, the API docs are silent, and one source points the
other way. Only a real test settles it.

### Owner test script (Phase 0)

No new code is needed. **Run these on beta (`pwusagebeta.fm.rodeo`) only.** Don't sign the second
account in on production before Phase 2: it would take the site over from the owner until the owner
signed in again. The takeover on beta's Dev database is what makes these tests cheap, because it
routes `createTeslaClientForSite` to the invited account. A push to any PR refreshes the dev copy and
clears its tokens, so sign in after the last push you expect.

Run the `scripts/set-backup-reserve.ts` steps with the Dev `.env`, and confirm first that
`DATABASE_URL` is the Dev database. The script uses the stored grant through the normal refresh lease.

| # | Test | Record |
| --- | --- | --- |
| T1 | In the Tesla app, invite the second account and accept. | Does the site appear in the second account's Tesla app? Can it change backup reserve there? |
| T2 | Sign the second account in on beta. | Login result. Is the same `energy_site_id` linked (`[TeslaAuthService] Linked site …`)? Does beta now show the site for this account? |
| T3 | Stay signed in as the second account and open the site: live data, today, history, rate plan. | Each one works, or its HTTP status. |
| T4 | `npx tsx scripts/set-backup-reserve.ts --site <id>` (read only), then `--percent <current+1> --confirm --restore`. | Command result or status code and error body. `site_info` lags by a minute or more; the script polls for this. |
| T5 | Start and stop Battery Saver on beta as the second account. | Do both work? Does the owner's Tesla app show the reserve change? |
| T6 | Compare `Site.json` on Dev before and after T2, and the `Tariff` row count for the site. | Do the two accounts get the same `site_info`, especially `tariff_content_v2`? Did a new tariff version appear? |
| T7 | Remove the second account in Manage Access. Immediately and after 1 hour, repeat T3 and T4, then sign in on beta again. | Status codes (403, 404 or something else) with the old access token and after a refresh. Is the site gone from `products`? |
| T8 | Add the account back and sign in on beta. | Same `energy_site_id`? Does access return? |
| T9 | Sign the owner in on beta, then repeat a read with each account. | Does each grant keep working when the other refreshes? |

Optional, if easy: does anything in the `products` entry identify a role or owner? If it does, this
design could use it instead of learning from denied commands.

Optional production check (read-only, not run for this spec): accounts that hold a grant but have no
site. Some may be car-only, but others may already have lost a takeover.

```sql
SELECT count(*) FROM "User" u
WHERE u.refresh_token IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Site" s WHERE s.user_id = u.id);
```

### What each result means

| Result | Consequence |
| --- | --- |
| **A.** Listed, reads work, commands work | Build this design as written. |
| **B.** Listed, reads work, commands denied | Build it. Those members see data, but Battery Saver start is unavailable for them. Restore uses a member who can send commands. |
| **C.** Not listed, or reads denied | Stop. Tesla can't vouch for membership, so sharing would need pwusage's own invites, with members reading through the owner's grant. That is a different product decision (Q2). Only the identity fixes in Phase 1 are still worth shipping. |
| **T6 shows differing `site_info`** | Required, not just preferred: non-connection members must not run `ensureSite` (section 5). |
| **T7 shows removal isn't visible quickly** | The daily check in section 6.4 becomes the upper bound on how long access outlives removal. Tell the owner the number. |

## 4. Schema

Create with `npm run db:migration:create add_site_member` from `cmd/next-app`; the generator adds the
RLS boilerplate. Migrations are idempotent and can't use `CONCURRENTLY`. Sketch:

```sql
CREATE TABLE IF NOT EXISTS "SiteMember" (
    site_id   TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_in_tesla_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tesla_missing_since   TIMESTAMPTZ,   -- first empty products list (section 6.4)
    commands_denied_at    TIMESTAMPTZ,   -- last typed 401/403 on a command (section 6.3)
    PRIMARY KEY (site_id, user_id)
);
-- resolveAuth looks memberships up by user on every request.
CREATE INDEX IF NOT EXISTS "SiteMember_user_id_idx" ON "SiteMember"(user_id);

ALTER TABLE "SiteMember" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SiteMember" FROM PUBLIC;
REVOKE ALL ON "SiteMember" FROM anon;
REVOKE ALL ON "SiteMember" FROM authenticated;
GRANT ALL ON "SiteMember" TO service_role;

ALTER TABLE "Site"
    ADD COLUMN IF NOT EXISTS tesla_connection_user_id TEXT,
    ADD COLUMN IF NOT EXISTS connection_lost_at TIMESTAMPTZ,      -- section 6.6
    ADD COLUMN IF NOT EXISTS connection_restored_at TIMESTAMPTZ;  -- section 6.6

-- The connection user must be a member. Removing the member clears the pointer.
-- SET NULL with a column list needs PostgreSQL 15+ (production is 17.6).
ALTER TABLE "Site" DROP CONSTRAINT IF EXISTS "Site_tesla_connection_member_fkey";
ALTER TABLE "Site" ADD CONSTRAINT "Site_tesla_connection_member_fkey"
    FOREIGN KEY (id, tesla_connection_user_id) REFERENCES "SiteMember"(site_id, user_id)
    ON DELETE SET NULL (tesla_connection_user_id);

-- Backfill current owners.
INSERT INTO "SiteMember" (site_id, user_id)
SELECT id, user_id FROM "Site" WHERE user_id IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE "Site" SET tesla_connection_user_id = user_id
WHERE user_id IS NOT NULL AND tesla_connection_user_id IS NULL;

-- Separate from last_checked_at, which imports keep bumping (section 6.4).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS memberships_checked_at TIMESTAMPTZ;

-- Who started a hold and who installed a device (sections 6.3, 7).
ALTER TABLE "BatteryHold" ADD COLUMN IF NOT EXISTS started_by_user_id TEXT
    REFERENCES "User"(id) ON DELETE SET NULL;
ALTER TABLE "TrmnlInstallation" ADD COLUMN IF NOT EXISTS installed_by_user_id TEXT
    REFERENCES "User"(id) ON DELETE SET NULL;
UPDATE "TrmnlInstallation" t SET installed_by_user_id = s.user_id
FROM "Site" s WHERE s.id = t.site_id AND t.installed_by_user_id IS NULL;
```

Also in this migration: replace `Site_user_id_fkey` with `ON DELETE SET NULL` (section 8).
`TrmnlInstallation.site_id` has no foreign key on `main`; PR #319 adds one, so whichever PR lands
second must keep it.

The foreign key and the section 8 deletion SQL were tried on a throwaway local PostgreSQL 18.6 with
minimal tables. It rejected a non-member connection user. Deleting a connection user left a shared site
with a NULL pointer. Deleting the last member removed the site and its children, and a direct site delete
and a user delete also worked. This was a sanity check on the sketch, not the Phase 1 test suite.

The backfill links only the account that currently holds each site. A household already trading the
site back and forth gets its second member at that person's next login.

**Why a pointer column instead of choosing a member in each query?** A stored choice stays on one
grant, doesn't move around between requests, keeps the existing joins simple, and can move atomically
with the same conditional `UPDATE` pattern as `DesignDecisions.md` section 1. About a dozen queries
join `User` through the site today, and each would otherwise need its own selection logic.

**Why not keep calling it `user_id`?** Its old name would keep reading as "owner" and invite access
checks against it. A new column also avoids a rename window during deploy: migrations and the new
deployment don't land at the same instant. `user_id` is dropped in Phase 4.

`scripts/mobile-route-egress-fixture.sql`, `src/lib/battery-hold-activity-test-db.ts` and any test
schema that creates `Site` by hand need the new table and columns. Check the dev-copy scripts
(`scripts/test-dev-copy-scripts.sh`) against the circular `Site` and `SiteMember` keys.

## 5. Authorization

Access checks already funnel through `SiteRepo.getSitesForUser`, so most of them change in one place.

| Code | Change |
| --- | --- |
| `SiteRepo.getSitesForUser` (`site-repo.ts:61`) | `WHERE id IN (SELECT site_id FROM "SiteMember" WHERE user_id = $1) ORDER BY id`. A sub-select avoids an ambiguous `user_id` with the unqualified column list, and the ordering keeps `getDefaultSiteId` stable. |
| `resolveAuth`, `verifySiteAccess`, `getAuthorizedSiteIds` (`auth-checks.ts`) | No code change: they inherit it. Add tests. Update the `site_auth` comments and the "owns the site" wording in `cmd/next-app/AGENTS.md`. |
| `checkRefreshNeeded` (`auth-jwt.ts:136`) | No code change: re-derives sites through `getSitesForUser`. Add a renewal test for an added and a removed member. |
| `SiteService.validateSiteAccess` and `getAuthorizedSites` | Inherit it. No change. |
| `/api/mobile/session` | Inherits it: already filters handoff claims by current sites. |
| `BatteryHoldActivityRepo.userCanAccessSite` and `claimForDelivery` | **Raw SQL `s.user_id = u.id`, doesn't inherit.** Replace with `EXISTS` on `SiteMember`. |
| `getTeslaCredentials` (`auth-checks.ts:64`) | No callers, and its "all sites belong to the same user" assumption is now false. Delete. |
| `/profile` (`src/app/profile/page.tsx:39-55`) | **Must change.** It loads the user from the first site's `user_id`, so a second member would see the first member's profile, and PR #319's Danger Zone would sit on it. Use `getCurrentUser()`. |
| `TeslaAuthService.handleTeslaCallback` (`tesla-auth-service.ts:833`) | See below. |

Admin behaviour doesn't change: admins can access every site without being members and never get a
`SiteMember` row from access alone. An admin whose own Tesla account lists a site becomes a member
like anyone else.

### Login

Replace `assignSiteToUser` with `SiteRepo.addSiteMember(siteId, userId)`:

1. Upsert the `SiteMember` row: set `last_seen_in_tesla_at`, clear `tesla_missing_since` and
   `commands_denied_at` (a new login can carry new scopes).
2. Claim the connection only if nobody usable holds it:
   `UPDATE "Site" SET tesla_connection_user_id = $user … WHERE id = $site AND <current connection is
   NULL or unusable>`. A login never moves a healthy connection.

Then reconcile (section 6.4) using the list `getProducts()` just returned.

**Skip `ensureSite` for a site that already exists when this user isn't its connection user.** It
rewrites `Site.json` and can add a tariff version when `tariff_content_v2` differs, so an invited
account's different view could churn shared data (T6). The site is already known, so this also saves
a Tesla call. If T3 shows `products` can list a site the account can't read, add a `getLiveStatus`
check here before granting membership.

Keep today's failure rules. An `ensureSite` failure for a new site means no membership and no change
to any existing membership. A failed `getProducts()` changes nothing.

A login racing a deletion can hit a foreign key error if the site was just deleted. Re-run
`ensureSite` and the insert once, which recreates it as a new empty site.

## 6. Tokens, crons and failover

### 6.1 Which token

| Work | Token | Why |
| --- | --- | --- |
| Live status, today refresh, gap heal, history, monitor reads | Site's connection user | A single stable grant. Any member's read is one Tesla already allows. |
| Person starts Battery Saver, changes anything in Tesla | **That person's own** | pwusage must not grant more than Tesla does. Tesla also then has the right account on record. |
| Battery Saver restore | Any member who can send commands (6.3) | It only undoes the hold, and the hold must never get stranded. |
| Daily verification and reconcile | Each user's own (6.4, 6.5) | They test that user's grant. |
| Admin acting on a site without being a member | Connection user | Same as today. |

The refresh coordinator (lease, generation, retry floors) stays per account and doesn't change. Site
claims (`acquireImportLock`, `claimLiveRefresh`) stay per site, so two members can't double-fetch.

### 6.2 Pin clients to one account

`createTeslaClientForSite` looks tokens up by site before each request, and its refresh handler looks
the user up by site. Once a connection can move, a client holding A's token could read B's stored
credentials or claim the wrong lease, then wait out a 20-second timeout.

- `createTeslaClientForSite` resolves the connection once, then builds the client as
  `createTeslaClientForUser` does: `currentTeslaConnection(userId)` and
  `getLockedUserRefreshHandler(userId)`, keeping `siteId` for telemetry. A connection change takes
  effect on the next client. This replaces the `Site owner changed` guard.
- `SiteService.loadSitePageData` builds its own client the same way and must go through the factory or
  match it. Keep its `auth-failure` recovery behaviour, which tests pin.
- Remove `getLockedRefreshHandler(siteId)` and `updateSiteTokens` (no callers).
- `UserRepo.getTokensForSite` joins on `tesla_connection_user_id` and stays a pure read.
- Invalidate `siteCache` when the connection changes on this instance. Other instances can hold a
  stale row, so nothing may trust cached tokens for longer than today: pinned clients re-read them.

### 6.3 Battery Saver restores

`BatteryHold` stays one per site, and its lease and deadline rules stay as `DesignDecisions.md`
describes. Today `monitorBatteryHolds` builds one client from the site, and a dead token means the
reserve stays parked until someone reconnects. With several members:

`getRestoreCandidates(hold)` returns usable members, ordered: the hold's starter, the connection user,
then the rest by `joined_at`. Members whose `commands_denied_at` is within 7 days go last, so a member
whose access changed is eventually retried.

Inside the existing lease and the 10-second restore deadline:

1. Try the next candidate only when the first attempt **proves** nothing was applied: no usable
   credentials before sending, or a typed 401/403 whose `clearRestoreAttempt` succeeded.
2. On any uncertain outcome (timeout, transport, 5xx, or failed cleanup), **stop**. Keep
   `restore_attempted_at` and let the existing reconcile and 15-minute guarded resend handle it.
   Sending through a second account doesn't make an uncertain command safe to repeat.
3. A typed 401/403 sets `commands_denied_at`, so the next monitor run starts further down the list if
   this one runs out of time. A successful command clears it.
4. A member's reserve change still cancels the hold through the existing `reserve_changed` check,
   whoever made it and in whichever app.

If nobody can restore, the hold stays active and keeps being retried. Every member's site page and
iOS Battery Saver card must say so, not only the starter's, along the lines of "Battery Saver can't
restore your reserve until someone reconnects Tesla." Any member's login makes them a candidate for
the next monitor run. Use `docs/voice-and-terms.md` for the final copy.

Manual stop tries the person's own token first, then uses the same candidate path, for the same
reason as the table above. Starting Battery Saver has no fallback: if the person's own connection is
lost the route returns the existing `needs_reauth`, and if Tesla denies their command it returns a new
`commands_denied` error. Record `started_by_user_id` on park.

### 6.4 Keeping membership in step with Tesla

Without this, the previous owner of a sold home keeps watching live data. Today's takeover happens to
end their access when the new owner signs in, and removing the takeover removes that.

Reconcile a user's memberships against a successful `getProducts()`:

- Site listed: set `last_seen_in_tesla_at`, clear `tesla_missing_since`.
- List is non-empty and the site isn't on it: remove the membership now.
- List is completely empty: set `tesla_missing_since` if unset. Remove the membership if it was
  already set at least 20 hours earlier. An empty list could be a Tesla blip, and removal would break
  the site's data collection.
- A failed call changes nothing.

Run it at each login and in the daily `check-users` cron, so access outlives removal by about a day at
worst (for an empty list, about two days). When the connection user gets a typed 401/403 on a site
endpoint, also reconcile that user, at most once an hour per user, so a removal is found sooner.
Remember that 403 alone doesn't prove removal: missing scopes also return 403. Finalise against T7.

**The cron's existing skip can't be reused.** `verifyAllUserStatuses` skips active users checked within
24 hours, and the importer bumps `last_checked_at` on every import. A connection user would therefore
never be reconciled, and that's exactly who a sold home's previous owner is likely to be. Track
`User.memberships_checked_at` separately and handle users oldest first under a time budget, because the
function is capped at 60 seconds on Vercel Hobby. Unfinished users carry over to the next run.

**A member with a dead grant can't be checked at all,** so a previous owner whose token was revoked
would otherwise keep seeing new data forever. If a member's grant has been unusable for 14 days and
another member holds a usable grant on that site, remove the membership. This reverses itself: if Tesla
still lists the site, their next login adds them back. A sole member keeps access and the existing
reconnect prompt, since nobody else's new data is involved.

Removing a membership (`SiteMembershipService.removeMember`) in one transaction: delete the row, which
clears the connection through the foreign key; disable that user's `BatteryHoldActivity` rows for the
site's holds; delete `TrmnlInstallation` rows they installed. Then repair the connection (6.5). **Never
delete a `Site` from reconciliation** (Q3). A session loses access on its next request because
`resolveAuth` reads the database.

### 6.5 Failover and standby grants

"Usable" means active account, refresh token present, and not `requiresTeslaReconnect`. A retry floor
or an in-flight refresh is **not** unusable. Transient trouble must not move the connection, or one
Tesla blip would move every site.

`SiteConnectionService.repairConnection(siteId)` picks the first usable member, ordered by
`commands_denied_at IS NULL` then `joined_at`, then applies it with compare-and-set on the old value,
and `rowCount` decides the winner. It runs:

- in `createTeslaClientForSite` when the current connection is NULL or unusable;
- as one set-based statement at the start of `heal-gaps` and `check-users`, because
  `getSitesForGapHeal` only sees sites with a usable connection and idle sites have no demand path;
- at the end of `removeMember` and on login (section 5).

The connection doesn't move back when a member reconnects, since that would be churn with no benefit.
When nobody is usable, the pointer stays on the last holder (or NULL) and members see the existing
reconnect prompt. Any member's login fixes it.

**Standby grants must stay alive.** Refresh tokens expire after 3 months, so a healthy standby member
that nothing ever uses would be dead just when failover needs it. `verifyAllUserStatuses` already
probes each active user daily, which is enough, provided `verifyUserStatus` is fixed:

- `user-repo.ts:311` finds a site by `Site.user_id`, and the `no_sites` guard and the `EXISTS` fence at
  `user-repo.ts:283-286` do the same. All three move to `SiteMember`.
- **It builds its client with `createTeslaClientForSite`.** After this change that would test the
  connection user's grant while recording the result on a different member, and the standby grant
  would quietly expire. Use `createTeslaClientForUser(user.id)`.

Cost: one `live_status` per standby member per day, already the norm per user, plus one `products`
call per user per day. Tesla's Energy API calls aren't billed today, and neither call writes a day
record, so database egress barely changes. Measure it in Phase 2 per the cron egress practice.

### 6.6 Outage stamps

`auth_lost_at` and `auth_restored_at` live on `User` but are read as "this site's access came back"
by `getSitesForGapHeal`, `UserRepo.getAuthRestoredAtForSite`, and two queries in
`compact-history-store.ts`. After a failover from A to B, B has no outage, so the days between A's
failure and the move would never get the recovery reach-back.

When `repairConnection` moves a connection, also set `Site.connection_lost_at` (the old user's
`auth_lost_at`, or, if there was no old user, the time of `last_live_refresh_at`) and
`Site.connection_restored_at = now()`. Add one SQL helper in the style of `latestStoredSampleSql`:

- restored = `GREATEST(u.auth_restored_at, s.connection_restored_at)`
- lost = `s.connection_lost_at` when `s.connection_restored_at` is the later restore, else
  `u.auth_lost_at`

Use it in all four places. The compact-history queries must go on using `LEFT JOIN`, so a site with no
connection user still resolves.

### 6.7 Remaining `s.user_id` uses

| Code | Change |
| --- | --- |
| `SiteRepo.loadSitesFromDB`, `getSitesForGapHeal` | Join the connection user. |
| `SiteRepo.getHistoryOverview` (admin) | `owner_email` becomes the connection user's email. Add a member count. |
| `UserRepo.getAllUsers` | All three uses move to `SiteMember`. A shared site appears under each member. |
| `UserRepo.getAuthRestoredAtForSite` | Section 6.6. |
| `Importer` (`index.ts:327`, `:389`) | `updateLastChecked` on the connection user. |
| `SolarBetaAdminRepo.listBetaSites` | Join `SiteMember`. The beta role belongs to a person. |
| `SolarBetaAdminRepo.findUserId` by site | Look up in `SiteMember`. The existing `rows.length === 1` check correctly refuses a shared site, so the admin must use an email. Add that to the error text. |
| `/api/trmnl/webhook` `syncUserEmail` | **Must change.** See section 7. |
| `scripts/check-missing-trmnl-plugin-ids.ts`, `measure-mobile-egress.ts` | Connection user. |
| `db-migrations/*` | History. Leave alone. |

`site/[id]/page.tsx:117` and the reconnect states are in section 7.

## 7. Shared and per-person data

| Data | Scope | Notes |
| --- | --- | --- |
| Rate plans (`Tariff` and children) | **Shared** | One utility bill per home. Append-only versioning already keeps every edit. No editor attribution in v1. |
| Billing day, timezone mode, Sankey renderer (`Site`) | **Shared** | Billing day must be. The two display settings could be personal, but that isn't worth a table yet (Q6). |
| Energy history, summaries, solar and live cache | **Shared** | One fetch for everyone. A new member sees history from before they joined (Q4). |
| Tags (`LoadTag`) | **Shared** | Site-keyed with no author. Any member can edit. |
| Battery Saver (`BatteryHold`) | **Shared** | One per site. Any member can see and stop it. Dismissing a cancel notice dismisses it for everyone, which is fine for v1. |
| Live Activity (`BatteryHoldActivity`) | **Per person** | Already keyed `(user_id, registration_id)`, so both members can follow a hold. Only the access checks change (section 5). |
| TRMNL (`TrmnlInstallation`) | **Device on a shared site** | See below. |
| Account, Tesla grant, session, region, roles (`User`) | **Per person** | Includes `fleet_api_base_url` and the solar beta role. |
| iOS site selection, widgets, Smart Shift and app settings | **Per device** | Stored locally. A removed member's widgets already clear on 401/403. |
| iOS solar layouts (private iCloud) | **Per Apple Account** | Two members each have their own, which can differ, and forecasts may too. Acceptable for a beta. |

**TRMNL.**

- Markup auth uses the installation's own token, so rendering is unaffected.
- Record `installed_by_user_id` in `/api/trmnl/setup`, including pending rows.
- When the installer is removed, delete their installation. Otherwise their device goes on showing the
  household's data forever, with no pwusage session to revoke. Their device then renders nothing until
  reinstalled.
- `/api/trmnl/manage` keeps its current rule: anyone with access to the linked site can manage it. A
  member can therefore relink the other member's device. That's acceptable within a household.
- `syncUserEmail` currently writes a TRMNL email onto `site.user_id`. On a shared site that can put one
  person's email on another's account, and login reconciles accounts by email, so a later Tesla login
  could land in the wrong account. Write only to `installed_by_user_id`, and only when that user has no
  email.
- `DesignDecisions.md` section 3 asks to flag this when the app becomes multi-user: the loose-pending
  "most recent within 15 minutes" match is more likely to pair the wrong row when two people in a house
  install together. The webhook's token check still authenticates, so this design doesn't make it
  unsafe, and it keeps the flow. Replacing it with a correlation token goes in `TODO.md` as its own
  work, and that section gets updated.

**Reconnect states.** Today `409 TESLA_CONNECTION_REQUIRED` means "your Tesla is disconnected". It
becomes two cases:

| Situation | Web and iOS |
| --- | --- |
| Site's connection is lost and no member can take over | Existing "Reconnect Tesla to update your data." for every member. |
| Site is fine but **your** Tesla connection is lost | No data warning. Data stays fresh. Battery Saver start shows reconnect, from the existing `needs_reauth`. |
| Tesla denies **your** commands | Battery Saver start explains that your Tesla access doesn't allow it, from `commands_denied`. |

Live-data routes already answer per site once `getTokensForSite` follows the connection, so the first
two rows need no change in those routes. `site/[id]/page.tsx:117` already reads per site too. Add a
query for the viewer's own connection state only where Battery Saver start is shown.

**iOS changes are small:** handle `commands_denied` in `DashboardCoordinator+BatteryHold` (it already
maps `needs_reauth`), and show the "can't restore" state from the hold response. If these touch the live
contract, change `MobileLiveContract.swift` and `mobile-dashboard-contract.ts` in the same PR. Older app
versions see `commands_denied` as a generic rejection, which is acceptable.

## 8. Account deletion

PR #319 ships first on the single-owner model. It adds `Site.user_id ON DELETE CASCADE` and deletes the
`User` row inside a transaction. That cascade must be gone **before a site can have two members**, or
one person deleting their account would erase the home's data for the other.

**Rule:** deleting an account removes that person's memberships. A site is deleted only when its last
member leaves. This replaces the "cascade-delete all owned sites" behaviour.

Phase 1 changes `AccountDeletionService.deleteUser` to this transaction:

```text
BEGIN
  sites := SELECT site_id FROM "SiteMember" WHERE user_id = $1
  SELECT 1 FROM "Site" WHERE id = ANY(sites) ORDER BY id FOR UPDATE   -- fixed order avoids deadlock
  DELETE FROM "MobileLoginHandoff" WHERE user_id = $1
  DELETE FROM "TrmnlInstallation"  WHERE installed_by_user_id = $1 AND site_id = ANY(sites)
  DELETE FROM "SiteMember"         WHERE user_id = $1               -- clears connection pointers
  DELETE FROM "Site" s WHERE s.id = ANY(sites)
    AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id) -- cascades to site data
  DELETE FROM "User" WHERE id = $1                                  -- cascades activity registrations
COMMIT
then repairConnection for each surviving site
```

The row locks make two members deleting at once safe: the second sees the first's row gone and deletes
the site. A concurrent login's membership insert waits on the same row (section 5 covers the retry).

**Before the transaction (best effort, must not block deletion):**

- Revoke only the departing person's grant. Other members hold their own (confirm with T9).
- Delete any TRMNL devices with PR #319's existing best-effort cleanup.
- **Battery Saver:** if a site has an active hold and no other member could restore it, try to restore
  now, using this person's token. If this was the last member, the cascade would otherwise delete the
  hold while the Powerwall stays parked at the raised reserve, with nothing left to restore it. **This
  gap is in PR #319 today, even for single owners.** If the restore fails, proceed and tell the person
  in the response that their reserve may still be raised.

**Dialog copy** must tell people what happens to a shared site. For example: "Homes shared with someone
else stay available to them, including their history." The same goes for the privacy page. Log
`sitesDeleted` and `sitesRetained` in place of `siteCount`.

**Notes for PR #319's author, whichever lands first:**

- Its plan calls `siteRepo.getSitesByUserId`, but the method is `getSitesForUser`.
- Its revoke URL uses host `fleet-auth.prd.na.vn.cloud.tesla.com`, while `Authentication.md` documents
  `fleet-auth.prd.vn.cloud.tesla.com` as the token host. Check it against Tesla's docs.
- Consider restoring active holds now, rather than waiting for this work.

**Sites with no members** can exist only after Tesla reconciliation removes everyone, as with a sold
home. They stay in place, crons skip them because no connection user joins, and the next person Tesla
lists becomes a member. Retention is Q3.

## 9. Rollout

Each phase is its own draft PR with passing lint, typecheck, tests and build.

**Phase 0: Tesla tests (owner, no code).** Section 3. Record results here and update this spec. Result
C stops the work apart from the identity fixes.

**Phase 1: Expand, with no behaviour change.**

- Migration (section 4), including `Site_user_id_fkey` to `ON DELETE SET NULL`.
- `assignSiteToUser` keeps taking over, and mirrors it in one transaction: set `user_id` and the
  connection, delete other `SiteMember` rows for the site, insert this user. The table therefore matches
  `user_id` exactly, so Phase 2 doesn't grant access to everyone who signed in during the rollout.
- Membership-based `AccountDeletionService`.
- Identity fixes that are correct either way: `/profile`, `syncUserEmail`, `verifyUserStatus` with its
  own client, pinned clients, `installed_by_user_id` and `started_by_user_id` writes.
- Check after deploy; expect 0 rows:

```sql
SELECT id FROM "Site" s
WHERE s.user_id IS DISTINCT FROM s.tesla_connection_user_id
   OR (s.user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id AND m.user_id = s.user_id));
```

**Phase 2: Cut over behind `SITE_MEMBERSHIP_ENABLED`.**

- Flag on: access reads `SiteMember`, login adds members, reconcile and failover run, commands use the
  actor's token, restores use candidates.
- Keep writing `user_id` equal to the connection in the same statement, so turning the flag off is a
  clean rollback. With the flag off, access falls back to `user_id`, so non-connection members lose
  access and nobody gains it.
- Beta first with both real accounts. Beta deploys need the CI env overrides, never `vercel redeploy`.
- Then production. Watch `tesla.refresh.*`, a new `site.connection.moved` event, and
  `site.member.removed`, and measure `check-users` egress.
- Soak for one to two weeks on production, including one full Battery Saver cycle by each member.

**Phase 3: Product surface.** Reconnect and `commands_denied` states on web and iOS, a member list in
site settings (Q5), and privacy and deletion copy. The iOS wrap-up needs an on-device check with the
worktree path and `open` command.

**Phase 4: Contract.** Remove the flag, `Site.user_id` writes and then the column (a separate migration
after a deploy), and `getTeslaCredentials`. Add a test that fails if `user_id` on `Site` comes back in
`src/`. Update `AGENTS.md` data model and auth notes, `Authentication.md`, and `DesignDecisions.md`
with a new section on membership, the connection pointer, and why a person's writes use their own
token. Update section 3 there. Remove the `TODO.md` entry.

**PR #319 order:** if #319 merges first, Phase 1 changes its foreign key and service. If Phase 1 merges
first, #319 is built on the membership algorithm from the start. Either way a second member can't exist
until Phase 2, after the cascade is gone.

## 10. Test plan

Write the failing test first. Automated tests never load `.env` or read `DATABASE_URL`, and never reach
Tesla.

**New `scripts/test-site-membership.sh`**, modelled on `scripts/test-battery-hold.sh`: `initdb` a
throwaway cluster in a temp socket directory, start it on an unused port (55439-55443 and 55447 are
taken), export only a test socket variable, and run `src/lib/site-membership-postgres.test.ts` plus any
additions. Apply the **real** migration file, not a hand-written copy of its schema, and require
PostgreSQL 15+.

| Area | Cases on real PostgreSQL |
| --- | --- |
| Migration | Backfill matches current owners; runs twice safely; RLS enabled and grants revoked; sites without a user stay memberless. |
| Key constraints | Connection user must be a member; removing them nulls the pointer; deleting a site with members and a connection succeeds; deleting a user clears the pointer on shared sites. |
| Login | Second account joins without changing the first's access or the connection; re-login is idempotent; a login claims a connection only when it's NULL or unusable. |
| Reconcile | Listed, missing from a non-empty list, first and second empty list, failed call; removal disables Live Activities and removes only the installer's TRMNL devices; never deletes a site; a recently imported connection user is still reconciled; a grant dead for 14 days is removed only when another member is usable, and login restores it. |
| Failover | Two workers repairing at once give one winner; transient retry floor doesn't move it; `reconnect_required` does; the set-based repair matches the single-site one; no failover copies any token column. |
| Token isolation | A pinned client never reads another member's credentials after a move; refresh claims only its own account; A's rotation leaves B's generation untouched. |
| Battery Saver | Typed 403 moves to the next candidate; timeout does **not**, and keeps `restore_attempted_at`; no candidates leaves the hold active; stale monitor can't restore a replacement hold; a member's reserve change cancels. |
| Verification | Probe uses that user's own grant, not the connection's; a standby's refresh keeps its generation moving; the `no_sites` fence uses membership. |
| Outage stamps | After a failover, heal reaches back to the old user's `auth_lost_at`; no-failover behaviour matches today. |
| Account deletion | Member leaves and the site, history and other member's access survive; last member removes every child table; two simultaneous deletions delete the site once with no deadlock; login racing deletion. |
| Live Activity delivery | Member receives pushes; a removed member's pending rows stop. |

Add the new script to whichever CI job runs `test-battery-hold.sh`, and extend that script's fixtures
for `userCanAccessSite` and `claimForDelivery`.

**Unit and route tests (Vitest, mocked):**

- `verifySiteAccess`, `resolveAuth` and `checkRefreshNeeded` for added and removed members
- Battery-hold route: actor's token on park; `needs_reauth` and `commands_denied`; no fallback on start
- `/profile` shows the signed-in member, not the first site's user
- `syncUserEmail` only writes to the installer
- Reconnect wording in each row of the section 7 table
- Flag off matches current behaviour
- `DELETE /api/user` with a shared site

**iOS (`run-tests.sh`, clean lint, zero warnings):** `commands_denied` handling, "can't restore" state,
and an existing 403 clearing the widget for a removed member.

**Manual on beta with both Tesla accounts, before production:**

1. Both signed in at once on web and iOS; each signing in again doesn't disturb the other.
2. A starts Battery Saver, B sees it and stops it; then B starts and A follows the Live Activity.
3. Disconnect the connection user (revoke in Tesla's consent page): data keeps updating through the other
   member, and a running hold still restores.
4. Remove B in Tesla: access is gone by the next check, and B's TRMNL device stops.
5. Delete B's account: A is unaffected. Delete A's account: site and children are gone.

## 11. Open questions for the owner

Recommendations are mine. Change anything that doesn't match what you want.

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | **Run the Phase 0 tests** with your spouse's Tesla account, and report the results. | Required before any build. About 30 minutes, plus the one-hour wait in T7. |
| Q2 | If Tesla's API doesn't list shared sites for the invitee (result C), should pwusage build its own invites? | No, not unless the household need is strong enough to justify it: members would read through the owner's grant, and pwusage would become responsible for access control and removal that Tesla handles today. |
| Q3 | When Tesla removes the last member (for example, a sold home) and nobody chose to delete anything, how long do we keep the site's data? | Keep for 30 days so a re-invite or mistaken removal loses nothing, then delete with a small daily job. This is the one place a site would go without an explicit "leaves" action. Keeping it forever is simpler, but it's a privacy cost. |
| Q4 | Should a new member see history from before they joined, including a new homeowner seeing the prior owner's data? | Yes for invited members, since Tesla's app shows them history anyway. The sold-home case already happens today through takeover. Mention it in the privacy page, and add a cutoff later if it matters. |
| Q5 | Should members see each other's email addresses in site settings? | Yes. It's how someone notices an unexpected person, and Tesla's invite already connects them. Show emails only, nothing else about the account. |
| Q6 | Any member can edit rate plans, tags and site settings, and display settings stay shared. OK? | Yes for v1. Make timezone and chart preferences personal only if someone asks. |
| Q7 | If Tesla denies an invited account commands (result B), may that person still start Battery Saver through pwusage using the owner's token? | No. It would hand them a permission Tesla withheld. Only the restore can use another member's token. |

## 12. Calls made in this spec

These are my choices, not owner decisions; override as needed.

- No owner role. The connection user is plumbing, never shown as "the owner".
- The connection never moves back automatically after a failover.
- Empty `products` needs a second result 20 or more hours later before removal; a non-empty list removes
  immediately.
- A `commands_denied_at` value expires after 7 days for candidate ordering.
- A member's dead grant is removed after 14 days when another member's grant works. A forgotten password
  reset can therefore remove someone's TRMNL device, which I accepted to avoid a former owner keeping a
  live view.
- Member removal deletes that person's TRMNL installations, rather than leaving them running.
- The `TrmnlInstallation` backfill credits existing devices to the site's current user.
- The loose-pending TRMNL flow stays for now, with its replacement tracked in `TODO.md`.
- Legacy `site_auth` tokens with no `sub` keep their claims-based path. The 30-day session cap means none
  should remain, so removing that branch is a separate cleanup.
