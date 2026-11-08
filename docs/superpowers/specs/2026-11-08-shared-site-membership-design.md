# Shared Powerwall sites: several Tesla accounts on one site

- **Date:** 2026-11-08, revised the same day after Phase 0 testing
- **Status:** Draft for owner review. Tesla command behaviour and the remaining questions are open (sections 3 and 13).
- **Area:** `cmd/next-app` (schema, auth, Tesla calls), small changes in `cmd/ios-app`
- **Related:** [account deletion PR KevM/pwusage#319](https://github.com/KevM/pwusage/pull/319), [`Authentication.md`](../../../Authentication.md), [`DesignDecisions.md`](../../../DesignDecisions.md), `codex/no-sites-login-loop` (`5fcfaa6e`)

## 1. Summary

Tesla gives each invited account its **own** `energy_site_id` for the same Powerwall, and a new one on
every re-invite. pwusage uses that ID as `Site.id`, so one home becomes several unrelated sites: separate
history, separate rate plans, and Battery Saver holds that can collide. The first version of this spec
assumed all accounts share one ID. Testing proved that wrong.

Recommendations:

1. **`Site.id` becomes pwusage's own ID.** It starts as the first Tesla ID seen and never changes, but it
   is no longer assumed to work at Tesla. This keeps every history, tariff and hold table as it is.
2. **Map each person to the site with their current Tesla ID.** `SiteMember` holds
   `(site_id, user_id, tesla_energy_site_id)`. Every Tesla call translates the ID for the token in use.
   Nothing outside that layer sees a Tesla ID. This is the alias approach the owner proposed.
3. **Recognise the home by hardware.** `Site.tesla_hardware_id` finds the existing site when a new ID
   appears. It identifies a home, and doesn't by itself grant access.
4. **Tesla's product list decides access.** An account that signs in with matching hardware joins only if
   an existing member's own product list still shows the site. Otherwise it gets a fresh site, so a new
   homeowner doesn't inherit the previous owner's history.
5. **Reads use one chosen member's token, and a person's own changes use theirs.** Only a Battery Saver
   restore may use another member's token.
6. **Ship two fixes first, because they affect production today:** a guard against two Battery Saver holds
   on one Powerwall, and clearing site rows Tesla no longer lists.

## 2. Goals and non-goals

**Goals**

- People on one Powerwall share one site in pwusage: one history, one rate plan, one Battery Saver.
- One copy of the data per home.
- Signing in never takes anything from another member, and a re-invite doesn't create another site.
- Data keeps updating, and Battery Saver still restores, if one member loses their Tesla connection.
- Removal in Tesla ends pwusage access without anyone acting in pwusage.

**Non-goals**

- Roles or an owner concept. Tesla's Manage Access stays the control.
- A "leave site" button: Tesla would list the site again at the next login.
- Per-person rate plans, tags or display settings.

**Failure even if it works technically**

- A new homeowner automatically sees the previous owner's history, or the reverse.
- A person can do something through pwusage that Tesla doesn't let their account do.
- A Tesla call is sent with an ID that doesn't belong to the token sending it.
- A failover copies or shares a Tesla grant. Each grant keeps exactly one holder
  (`DesignDecisions.md`, "The one precondition").

## 3. What Tesla does

### Confirmed by production testing on the Harrison site

Results below came from a separate testing session and its report. This spec didn't re-run them.

| Finding | Evidence | What it means |
| --- | --- | --- |
| Each invited account gets a different ID | Owner `2252268092126997`, partner `2252280026496352`, son `2534053021086015`, with matching hardware ID and installation details | `energy_site_id` can't identify a home |
| Invited accounts can read site info | The partner's login fetched `site_info` | The join flow can read hardware |
| Removal shows up in `getProducts()` | Four sign-ins after removal succeeded at Tesla and returned zero sites | The product list is a usable access signal, and an empty list can be real |
| A re-invite issues another new ID | Son's next sign-in returned `2534048291823253` | One person's ID can change, so the mapping must be updatable. It looks like an ID belongs to an invite, not to a person. That is an inference from one example |
| pwusage keeps stale rows | The son now sees two Harrison sites | Production bug, fixed in Phase 1 |

### Tesla's documentation

- [Manage Access](https://www.tesla.com/support/energy/powerwall/mobile-app/manage-access-energy-system):
  "If you add a user, that user will have access to all the Tesla app features for your energy system."
  This describes the Tesla app, not the API.
- [Energy endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/energy) and
  [scopes](https://developer.tesla.com/docs/fleet-api/authentication/overview) don't separate owners from
  invited users. `energy_cmds` covers "settings like backup reserve percent".
- [Refresh tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens) are single
  use and expire after 3 months.
- [Ownership transfer](https://www.tesla.com/support/energy/powerwall/own/transferring-ownership) needs the
  deed and sticker photos sent to Tesla support. Tesla doesn't say when the seller loses access or whether
  the ID changes.

### The hardware ID is already stored

`Site.json` holds Tesla's `site_info`, and its `id` field works as the identifier. A read-only count on 2026-11-08, using the
Supabase connector, found `json.id` on all 88 site rows, with 85 distinct values. The only value shared by several rows is
Harrison's, across its 4 rows. So one home among 85 has duplicates, and the backfill needs no Tesla calls. The check compared
values without reading them, so what `id` physically refers to is still unconfirmed, and I didn't confirm whether that project
is production or a recent copy of it. Check that before running the backfill.

### Still unknown

| # | Question | How to answer | Effect |
| --- | --- | --- | --- |
| U2 | Can an invited account's token change the reserve using its own current ID? | The earlier Battery Saver attempt sent no command, so it proved nothing. Run `scripts/set-backup-reserve.ts --site <id> --percent <current+1> --confirm --restore` as the invited account on beta. | If denied: those members see data, Battery Saver start is unavailable for them, and restore needs a member who can send commands. The design holds either way. |
| U3 | What does a removed account's token get when it calls its old ID? **Reads are answered:** on 2026-11-08 production gap heal called the son's replaced ID, refreshed the token after a 401, then got `404 not_found` from `calendar_history`. Commands are still unknown. | Same script, after removal. | Sets what a removed connection user's failed reads look like while they wait for the daily check (section 6.3). Not a blocker. |
| U4 | What happens at the API during a real ownership transfer? | Asked Tesla in [SUPPORT-2194](https://fleetapi-support.tesla.com/servicedesk/customer/portal/1/SUPPORT-2194), opened 2026-11-08, no answer yet. A real sale can't be simulated. | Sets how much the seller-removal timing risk (section 5) matters. |
| U5 | Does hardware ID survive a gateway or Powerwall replacement? | Ask Tesla, or watch for it. | If not, a replaced system becomes a fresh site. Acceptable, but known. |

## 4. Schema

Create with `npm run db:migration:create add_site_member`, which adds the RLS boilerplate. Migrations are
idempotent and can't use `CONCURRENTLY`. Sketch:

```sql
CREATE TABLE IF NOT EXISTS "SiteMember" (
    site_id   TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    tesla_energy_site_id  TEXT NOT NULL UNIQUE,  -- this account's current ID at Tesla
    joined_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_in_tesla_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    commands_denied_at    TIMESTAMPTZ,           -- last typed 401/403 on a command
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
    ADD COLUMN IF NOT EXISTS tesla_hardware_id TEXT,
    ADD COLUMN IF NOT EXISTS tesla_connection_user_id TEXT,
    ADD COLUMN IF NOT EXISTS connection_lost_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS connection_restored_at TIMESTAMPTZ;
-- Not unique: duplicates exist until merged, and a new owner can get a fresh site.
CREATE INDEX IF NOT EXISTS "Site_tesla_hardware_id_idx" ON "Site"(tesla_hardware_id);

-- The connection user must be a member. Removing the member clears the pointer.
ALTER TABLE "Site" DROP CONSTRAINT IF EXISTS "Site_tesla_connection_member_fkey";
ALTER TABLE "Site" ADD CONSTRAINT "Site_tesla_connection_member_fkey"
    FOREIGN KEY (id, tesla_connection_user_id) REFERENCES "SiteMember"(site_id, user_id)
    ON DELETE SET NULL (tesla_connection_user_id);

-- Backfill: today every Site.id is its owner's Tesla ID, and json.id is site_info.id.
UPDATE "Site" SET tesla_hardware_id = json ->> 'id'
WHERE tesla_hardware_id IS NULL;
INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id)
SELECT id, user_id, id FROM "Site" WHERE user_id IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE "Site" SET tesla_connection_user_id = user_id
WHERE user_id IS NOT NULL AND tesla_connection_user_id IS NULL;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS memberships_checked_at TIMESTAMPTZ;
ALTER TABLE "BatteryHold" ADD COLUMN IF NOT EXISTS started_by_user_id TEXT
    REFERENCES "User"(id) ON DELETE SET NULL;
ALTER TABLE "TrmnlInstallation" ADD COLUMN IF NOT EXISTS installed_by_user_id TEXT
    REFERENCES "User"(id) ON DELETE SET NULL;
UPDATE "TrmnlInstallation" t SET installed_by_user_id = s.user_id
FROM "Site" s WHERE s.id = t.site_id AND t.installed_by_user_id IS NULL;
```

The same migration changes `Site_user_id_fkey` to `ON DELETE SET NULL` (section 9). `user_id` itself is
dropped in Phase 5.

The connection foreign key and deletion SQL were tried on a throwaway local PostgreSQL 18.6 with minimal
tables. It rejected a non-member connection user. Deleting a connection user left a shared site with a NULL
pointer. Deleting the last member removed the site and its children, and a direct site delete and a user
delete also worked. `ON DELETE SET NULL (column)` needs PostgreSQL 15+, and production is 17.6. This was a
check on the sketch, not the Phase 1 test suite.

**Why one mapping table, not `SiteMember` plus an alias table?** Each person has exactly one current ID per
home, so the ID is a property of the membership. A re-invite simply updates that row.

**No alias for old IDs.** iOS already falls back to the first available site when the saved one is gone
(`PWUsageAppModel+Sites.swift:63`), and the web dashboard links from the site list. An old bookmark gets the
normal unauthorized response, and merges repoint TRMNL devices (section 10). Old IDs only exist for rows that
get merged, which should be rare.

## 5. Login and joining

For each energy product in a successful `getProducts()` with Tesla ID `T`:

| Step | Check | Action |
| --- | --- | --- |
| 1 | `T` is already mapped to this user | Touch `last_seen_in_tesla_at`. If this user is the connection user, run the existing site refresh. |
| 2 | Read hardware `H` for `T`. This user already belongs to a site with `H`. | **Re-invite:** set their `tesla_energy_site_id = T`. No new site. |
| 3 | A site with `H` has an existing member, and that member's own `getProducts()` still lists their mapped ID. | **Join:** add this user with `T`. Skip `ensureSite`, which could rewrite shared `Site.json` and tariffs. |
| 4 | Anything else | **Fresh site:** today's `ensureSite`, with `Site.id = T`, `H` stored, and this user as member and connection. |

Rules:

- Check at most 3 existing members, most recently seen first, using each one's own token and refresh lease.
- **A Tesla error or timeout on that check fails the login** with the existing `fleet-api-failed` result, so a
  blip doesn't create a permanent duplicate. A member whose grant is definitely unusable just doesn't count.
- A member check matches on their mapped ID in `products`. If `products` turns out to carry the same identifier, compare that directly.
- Don't hold a transaction across Tesla calls. Do them first, then in one transaction take
  `pg_advisory_xact_lock(hashtext(H))`, re-check steps 1 and 2, and write. That stops two first logins
  creating two sites.
- `site_info` missing the hardware field: fall through to step 4 with a NULL `H`, and log it.
- Then reconcile (section 6.3) using this same product list.

### Partner or new owner?

Tesla's data can't fully tell them apart, since both can show up as a new ID with matching hardware.

| Situation | Result |
| --- | --- |
| Household member invited through Tesla | The inviter's list still shows the site, so they join. |
| New owner, seller already removed | Seller's list no longer shows it, or their token is dead, so a fresh site. |
| **New owner, seller not yet removed** | **Wrong join.** The buyer sees the seller's history. The seller may see new data until the daily check removes them. |
| Partner, but the only member's token is dead | Fresh site: an unwanted duplicate, which an admin can merge later. |

**Owner decision (2026-11-08): join automatically on this live check, with no invite link.** Testing showed
removal really does appear in `getProducts()`, and a link would add a screen and tokens and leave duplicates for
everyone who doesn't use it.

The owner accepted the third row as a known risk. Tesla's transfer needs the deed and a support ticket, which
makes the window narrow but doesn't rule it out, and U4 would show how narrow.

## 6. Tesla calls and tokens

### 6.1 Translating IDs

This is the core of the change, and where a mistake would be easiest to miss: **`Site.id` may no longer exist
at Tesla**, even for the original member after a re-invite.

- `createTeslaClientForSite` picks a member, then builds a client pinned to that one account: its
  `beforeRequest` uses `currentTeslaConnection(userId)`, its refresh uses `getLockedUserRefreshHandler(userId)`,
  and it knows that member's `tesla_energy_site_id`.
- `TeslaClient`'s site calls (`site_info`, both `calendar_history` calls, `live_status`, `backup`) translate
  through a resolver supplied at construction. **An unmapped ID throws, and never falls back to `Site.id`.**
  So callers and importers keep passing `Site.id`, and stored rows stay keyed by it.
- `SiteService.loadSitePageData` builds its own client and must use the factory or match it.
- `SiteService.fetchSitesFromApi` (`site-service.ts:364`) returns Tesla IDs and compares them with `Site.id`.
  Map them through `SiteMember` for this user. This is the legacy no-JWT path.
- Remove `getLockedRefreshHandler(siteId)` and `updateSiteTokens` (no callers). The `Site owner changed` guard
  goes too.
- `scripts/set-backup-reserve.ts --site` and similar scripts take `Site.id` and use the factory.

**Keep the mapping out of `getSite()`.** `Site` rows are plain objects cached for 15 minutes per instance, and
`loadSitesFromDB` already leaves tokens out of that cache because they change outside the process. A Tesla ID has the
same problem, since a re-invite replaces it. A list of every member's IDs on `Site` also means each caller has to pick
the right one for the token it holds, and it could end up in a response. Instead, the query that loads the pinned
account's credentials also returns that account's `tesla_energy_site_id`. That covers `beforeRequest` too, so a
re-invite takes effect with no extra query. One private helper in `TeslaClient` builds the five site URLs.

Pinning also matters without translation: a client holding A's token must never read B's stored credentials
or claim B's refresh lease after the connection moves.

### 6.2 Which token

| Work | Token |
| --- | --- |
| Live status, today refresh, gap heal, history, monitor reads | Site's connection user |
| A person starts Battery Saver | **That person's own**, with no fallback |
| Battery Saver restore | Any member who can send commands (section 7) |
| Daily verification and reconcile | Each user's own |
| Admin on a site they aren't a member of | Connection user, as today |

The refresh coordinator stays per account. Site claims (`acquireImportLock`, `claimLiveRefresh`) stay per site,
so two members can't double-fetch.

### 6.3 Keeping membership in step with Tesla

Reconcile against a successful `getProducts()`, at each login and daily:

- Mapped ID listed: touch `last_seen_in_tesla_at`.
- Not listed, but the hardware matches another listed ID: update the mapping (re-invite).
- **Not listed, including an empty list: remove the membership.** Testing showed an empty list is how removal
  really looks, and a wrong removal fixes itself at the next login. This replaces the earlier
  wait-for-a-second-result rule.
- A failed call changes nothing.

**A failed site request never triggers a reconcile.** A 401 is normally an expired access token, which the client is
already refreshing and retrying, a 403 can also mean a missing scope, and a replaced ID answers 404 (U3). Checking from the request path would overlap
with that refresh and add a Tesla call to a failing request, for a rare case. If a removed member is the connection user,
data can stall until the next login or daily check, about a day at worst. Battery Saver restores don't wait for this:
they already move to the next candidate on a typed 401/403 (section 7).

Log it so we can see when this happens: `logEvent('warn', 'site.connection.request-rejected', { siteId, accountId, status })`,
with `accountId` hashed like the existing `tesla.refresh.*` events. Emit it only for a final 401, 403 or 404, after any
refresh and retry, so a routine token expiry doesn't count. The event only records the rejection and changes nothing.

**Removal must not undo a newer write.** A login or cron can read the product list, then a re-invite login can update the
mapping before the removal runs. Delete only when `tesla_energy_site_id` still equals the ID that list was checked against
and `last_seen_in_tesla_at` is older than when the list was fetched. `rowCount = 0` means something newer won, so do nothing.
Run reconciles outside any lease or transaction, through the normal refresh coordinator. If the list call fails or is in a
retry floor, nothing changes.

**The cron's existing skip can't be reused.** `verifyAllUserStatuses` skips users checked within 24 hours, and the
importer bumps `last_checked_at` on every import, so connection users would never be reconciled. Use
`memberships_checked_at`, oldest first, under a time budget, since Vercel Hobby caps functions at 60 seconds.

**A dead grant can't be checked.** If a member's grant has been unusable for 14 days and another member's
works, remove the membership. If Tesla still lists them, their next login adds them back. A sole member keeps
access and the existing reconnect prompt.

`removeMember` runs in one transaction: delete the row (which clears the connection through the foreign key),
disable their `BatteryHoldActivity` rows for that site's holds, and delete TRMNL installations they installed.
Then repair the connection. **Reconcile never deletes a `Site`** (Q3). Someone left with no sites sees the
"No Powerwall access" page from `codex/no-sites-login-loop`.

### 6.4 Failover and standby grants

"Usable" means active account, refresh token present, and not `requiresTeslaReconnect`. A retry floor or
in-flight refresh isn't unusable: transient trouble must not move the connection.

`repairConnection(siteId)` picks the first usable member, preferring those without `commands_denied_at`, then by
`joined_at`, and applies it with compare-and-set (`DesignDecisions.md` section 1). It runs in
`createTeslaClientForSite` when the connection is unusable, as a set-based statement at the start of `heal-gaps`
and `check-users`, after `removeMember`, and at login. It never moves back automatically.

**Standby grants must stay alive,** since refresh tokens expire after 3 months. The daily probe covers this, but
`verifyUserStatus` must change:

- `user-repo.ts:311` and the fences at `user-repo.ts:283-286` use `Site.user_id`. Move them to `SiteMember`.
- It builds its client with `createTeslaClientForSite`, which would test the **connection user's** grant while
  recording the result on someone else. Use a client pinned to that user, probing their own mapped ID.

### 6.5 Outage stamps

`auth_lost_at` and `auth_restored_at` live on `User` but are read as "this site's access came back" by
`getSitesForGapHeal`, `getAuthRestoredAtForSite` and two queries in `compact-history-store.ts`. After a failover
the new user has no outage, so the recovery reach-back would be lost.

When the connection moves, set `Site.connection_lost_at` (old user's `auth_lost_at`, or `last_live_refresh_at` if
there was no old user) and `connection_restored_at = now()`. One SQL helper, like `latestStoredSampleSql`, yields
restored = `GREATEST(u.auth_restored_at, s.connection_restored_at)`, and lost = `s.connection_lost_at` when that is
the later restore, else `u.auth_lost_at`. Keep the `LEFT JOIN`s.

### 6.6 Other `s.user_id` uses

| Code | Change |
| --- | --- |
| `SiteRepo.getSitesForUser` (`:61`) | `WHERE id IN (SELECT site_id FROM "SiteMember" WHERE user_id = $1) ORDER BY id`. |
| `resolveAuth`, `verifySiteAccess`, `checkRefreshNeeded`, `validateSiteAccess`, `/api/mobile/session` | Inherit it. Add tests. |
| `BatteryHoldActivityRepo.userCanAccessSite`, `claimForDelivery` | **Raw SQL, doesn't inherit.** Use `EXISTS` on `SiteMember`. |
| `getTeslaCredentials` (`auth-checks.ts:64`) | No callers. Delete. |
| `/profile` (`profile/page.tsx:39-55`) | **Must change.** It loads the user from the first site, so one member would see another's profile, with PR #319's delete button on it. Use `getCurrentUser()`. |
| `UserRepo.getTokensForSite`, `SiteRepo.loadSitesFromDB`, `getSitesForGapHeal` | Join the connection user. |
| `getHistoryOverview`, `Importer` (`:327`, `:389`) | Connection user. |
| `UserRepo.getAllUsers` | Use `SiteMember`. A shared site appears under each member. |
| `SolarBetaAdminRepo` | Use `SiteMember`. Its existing `rows.length === 1` check correctly refuses a shared site, so the admin uses an email. |
| `/api/trmnl/webhook` `syncUserEmail` | **Must change** (section 8). |

Reconnect wording: "Reconnect Tesla to update your data" shows only when no member can keep the site updating. If
only the viewer's connection is lost, data stays fresh and only Battery Saver start asks them to reconnect.

## 7. Battery Saver

**The bug in production today.** The one-active-hold index is per `Site.id`, so duplicate rows can each hold the
same Powerwall. Your reserve is 20% and you park at 80%. Your partner parks too, saving 80% as "original" with a
100% target. Your hold sees 100%, cancels as `reserve_changed`, and never restores. Your partner's restores to 80%.
The reserve stays at 80%. This comes from reading the code, not from running it.

**Guard (Phase 1).** Before parking, refuse if another `Site` with the same `tesla_hardware_id` has an active hold
that isn't past `safety_expires_at`. Ignoring expired holds stops a previous owner's dead hold from blocking a new
owner. Once rows merge the unique index does this job, but the guard stays for any remaining duplicates.

**Restores with several members.** `getRestoreCandidates(hold)` returns usable members: the hold's starter, the
connection user, then the rest by `joined_at`. Those denied commands within 7 days go last. Each uses its own token
and its own Tesla ID.

Inside the existing lease and 10-second deadline:

1. Try the next candidate only when the attempt **proves** nothing was applied: no usable credentials, or a typed
   401/403 whose `clearRestoreAttempt` succeeded. Treat a typed 404 the same way only if U3 confirms commands answer 404
   for a replaced ID. A stale mapping would otherwise block a restore until the next reconcile.
2. On any uncertain outcome, **stop**. Keep `restore_attempted_at` and let the existing reconcile and 15-minute guarded
   resend handle it. A second account doesn't make an uncertain command safe to repeat.
3. A typed 401/403 sets `commands_denied_at`, and a successful command clears it.
4. A member's reserve change still cancels through the existing check.

If nobody can restore, the hold stays active and keeps retrying, and **every** member sees that it needs someone to
reconnect Tesla. Manual stop tries the person's own token first, then the candidates. Starting has no fallback:
`needs_reauth` if their connection is lost, new `commands_denied` if Tesla refuses. Using another member's token here
would hand them a permission Tesla withheld.

## 8. Shared and per-person data

| Data | Scope | Notes |
| --- | --- | --- |
| Rate plans, billing day, tags, display settings | **Shared** | Append-only tariff versions keep every edit. |
| History, summaries, live cache | **Shared** | One fetch for everyone. New members see earlier history (Q4). |
| Battery Saver | **Shared** | One per site. Any member can see and stop it. |
| Live Activity registrations | **Per person** | Already keyed `(user_id, registration_id)`. Only access checks change. |
| TRMNL installations | **Device on a shared site** | See below. |
| Account, grant, session, region, roles | **Per person** | Includes `fleet_api_base_url` and the solar beta role. |
| iOS selection, widgets, Smart Shift | **Per device** | Removed members' widgets already clear on 401/403. |
| iOS solar layouts | **Per Apple Account and site** | Keyed by account and `siteID`, so a member whose row merges into another site has to set theirs up again. |

**TRMNL.** Markup auth uses the installation token, so rendering is unaffected. Record `installed_by_user_id` in
`/api/trmnl/setup`. Delete an installation when its installer is removed, or their device goes on showing the home's
data with no session to revoke. Members can manage each other's devices, which is fine within a household.

`syncUserEmail` writes a TRMNL email onto `site.user_id`. On a shared site that could put one person's email on
another's account, and login reconciles accounts by email, so a later login could land in the wrong account. Write
only to `installed_by_user_id`, and only when that user has no email.

`DesignDecisions.md` section 3 asks to flag this when the app is multi-user: the loose-pending "most recent within 15
minutes" match is likelier to pair the wrong row when two people install together. The token check still authenticates,
so the flow stays, and replacing it goes in `TODO.md`.

**iOS changes are small:** handle `commands_denied` and the "can't restore" state. If these touch the live contract,
change `MobileLiveContract.swift` and `mobile-dashboard-contract.ts` in the same PR.

## 9. Account deletion

PR #319 ships first, deleting a user's sites with `Site.user_id ON DELETE CASCADE`. That's safe while every person has
their own row, and it stops being safe at the first merged site. So Phase 1 replaces the cascade.

**Rule:** deleting an account removes that person's memberships. A site goes only when its last member leaves.

```text
BEGIN
  sites := SELECT site_id FROM "SiteMember" WHERE user_id = $1
  SELECT 1 FROM "Site" WHERE id = ANY(sites) ORDER BY id FOR UPDATE   -- fixed order avoids deadlock
  DELETE FROM "MobileLoginHandoff" WHERE user_id = $1
  DELETE FROM "TrmnlInstallation"  WHERE installed_by_user_id = $1 AND site_id = ANY(sites)
  DELETE FROM "SiteMember"         WHERE user_id = $1               -- clears connection pointers
  DELETE FROM "Site" s WHERE s.id = ANY(sites)
    AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id)
  DELETE FROM "User" WHERE id = $1
COMMIT
then repairConnection for each surviving site
```

Two members deleting at once is safe: the second sees the first's row gone and deletes the site.

**Before the transaction (best effort):**

- Revoke only the departing person's grant.
- **Battery Saver:** if a site has an active hold and no other member could restore it, try to restore now. Otherwise
  the cascade deletes the hold while the Powerwall stays at the raised reserve. **This gap is in PR #319 today, even for
  single owners.** If it fails, delete anyway and say the reserve may still be raised.

The deletion dialog and privacy page must say that homes shared with someone stay available to them, including their
history. Log `sitesDeleted` and `sitesRetained`.

**For PR #319's author:** its plan calls `siteRepo.getSitesByUserId`, but the method is `getSitesForUser`, and its revoke
host (`fleet-auth.prd.na.vn.cloud.tesla.com`) differs from the token host in `Authentication.md`
(`fleet-auth.prd.vn.cloud.tesla.com`).

## 10. Merging existing duplicates

Only rows with matching hardware need this. Today that is Harrison alone, with four rows, one of them stale. Automatic merging of real history is too risky for something this rare, so this is an admin script,
`scripts/merge-duplicate-site.ts`, dry run by default:

1. Report groups by `tesla_hardware_id`, with members, day counts, tariff versions, tags and TRMNL devices.
2. For a chosen pair, keep the row with more history. **Refuse if either has an active hold.** Flag rate plans that differ,
   because the secondary's are dropped.
3. In one transaction: move the secondary's members to the primary, keeping each `tesla_energy_site_id`; repoint TRMNL
   installations and tags; delete the secondary, which cascades its history and activity registrations.
4. Days the primary lacks come back through gap healing, because members can still fetch them.

Run production merges only with the owner's approval, after a backup. Warn affected members that iOS solar layouts need
setting up again.

## 11. Rollout

Each phase is its own draft PR with lint, typecheck, tests and build passing.

**Phase 0: testing.** Done, apart from U2 to U5. None of them block Phase 1.

**Phase 1: Fixes for today, no sharing yet.**

- Merge `codex/no-sites-login-loop`, verified but not yet pushed.
- Migration (section 4). Backfill the hardware ID.
- Battery Saver guard across rows with the same hardware.
- At login, clear `user_id` on rows this user holds that a successful product list doesn't include. This removes stale
  sites like the son's, and stops removed people reading stored data.
- Membership-based `AccountDeletionService`, and `Site_user_id_fkey` to `SET NULL`.
- Identity fixes that are right either way: `/profile`, `syncUserEmail`, `verifyUserStatus`, pinned clients.
- `assignSiteToUser` mirrors into `SiteMember` and the connection, so the table matches `user_id` exactly. Check after
  deploy; expect 0 rows:

```sql
SELECT id FROM "Site" s
WHERE s.user_id IS DISTINCT FROM s.tesla_connection_user_id
   OR (s.user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id AND m.user_id = s.user_id));
```

**Phase 2: Translation, no behaviour change.** Every Tesla call goes through the resolver. All mappings equal `Site.id`
at this point, so nothing should change. Doing this alone makes any missed call site show up as an error before it could
send a wrong ID.

**Phase 3: Cut over behind `SITE_MEMBERSHIP_ENABLED`.** Access reads `SiteMember`, the join flow runs, and reconcile,
failover, per-person commands and restore candidates turn on. Keep `user_id` equal to the connection, so turning the flag
off is a clean rollback: non-connection members lose access, and nobody gains it. Beta first, with real accounts. Beta
deploys need the CI env overrides, never `vercel redeploy`. Then production. Watch `tesla.refresh.*`, plus new
`site.member.joined`, `site.member.removed`, `site.connection.moved` and `site.connection.request-rejected` events, and measure `check-users` egress.

**Phase 4: Product and cleanup.** Member list (Q5), reconnect and `commands_denied` states on web and iOS, privacy and
deletion copy, and the merge script. Merge Harrison with the owner's approval. iOS wrap-up needs an on-device check with
the worktree path and `open` command.

**Phase 5: Contract.** After a soak of one to two weeks, remove the flag, `user_id` writes, then the column in a separate
migration. Update `AGENTS.md`, `Authentication.md`, and `DesignDecisions.md` with a new section on why `Site.id` isn't a
Tesla ID and why a person's writes use their own token, plus section 3.

## 12. Tests

Write the failing test first. Automated tests never load `.env` or read `DATABASE_URL`, and never reach Tesla.

**New `scripts/test-site-membership.sh`**, modelled on `scripts/test-battery-hold.sh`: a throwaway cluster on a temp socket
and an unused port (55439-55443 and 55447 are taken), running `src/lib/site-membership-postgres.test.ts`. Apply the **real**
migration file, and require PostgreSQL 15+. Use a short socket path, as that script does, since a long one fails to start.

| Area | Cases on real PostgreSQL |
| --- | --- |
| Migration | Backfill matches owners with `tesla_energy_site_id = Site.id`; runs twice; RLS and grants; missing hardware field stays NULL. |
| Keys | Connection must be a member; removal nulls it; site and user deletes succeed. |
| Joining | Each row of the section 5 table, including all three-account Harrison IDs. A re-invite updates the row and creates no site. Member check error fails the login. Two first logins make one site. |
| Sold home | Seller unlisted or dead gives a fresh site, and the buyer can't read the seller's site. Seller still listed joins, then is removed at the next reconcile (documents the known risk). |
| Translation | Each Tesla call sends the token owner's ID; unmapped throws; no call ever sends `Site.id` unless it is that member's mapping. |
| Reconcile | Listed; re-invited; missing; empty; failed call; a stale list can't remove a mapping a re-invite login just updated; a failed site request starts no reconcile and logs `site.connection.request-rejected` only after the retry, including a final 404; recently imported connection user is still reconciled; dead grant removal only when another member works. |
| Failover | Two workers give one winner; retry floor doesn't move it; no token columns copied; outage stamps reach back. |
| Battery Saver | Guard across rows; expired hold ignored; typed 403 moves on; timeout doesn't; no candidates leaves it active; stale monitor can't restore a replacement. |
| Verification | Probe uses that user's grant and ID. |
| Deletion | Member leaves and the site survives; last member removes everything; simultaneous deletes; login racing deletion. |
| Merge | Moves members, TRMNL and tags; refuses with an active hold; dry run writes nothing. |

**Vitest, mocked:** access helpers for added and removed members, battery-hold route tokens and errors, `/profile`, `syncUserEmail`,
reconnect wording, flag off matches current behaviour, and `DELETE /api/user` on a shared site.

**iOS (`run-tests.sh`, clean lint, zero warnings):** `commands_denied`, "can't restore", saved site gone after a merge.

**Manual on beta with real accounts:** owner, partner and son all on one site at once; removal and re-invite give no new sites;
Battery Saver started by one and stopped by another; connection user disconnected while data and a running hold carry on; account
deletions in each order.

## 13. Open questions for the owner

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | **Run the invited-account command test (U2).** | Needed before Phase 3, not before Phase 1. |
| Q2 | How should a second account join? | **Decided by the owner: automatically on the live check** (section 5). A buyer joining a seller's site before Tesla removes the seller is an accepted risk. |
| Q3 | When Tesla removes the last member (a sold home) and nobody chose to delete anything, how long do we keep the data? | Delete after 30 days with a small daily job. Crons skip it in the meantime. Keeping it forever is simpler but has a privacy cost. |
| Q4 | Should new members see history from before they joined? | Yes. Tesla's app shows invited users history too. Mention it on the privacy page. |
| Q5 | Should members see each other's email addresses in site settings? | Yes. It's how someone spots an unexpected person. Emails only. |
| Q6 | Any member can edit rate plans, tags and settings. OK? | Yes for v1. |
| Q7 | If Tesla denies an invited account commands (U2), may they start Battery Saver through pwusage using another member's token? | No. It hands them a permission Tesla withheld. |

## 14. Calls made in this spec

My choices, not owner decisions. Override as needed.

- `Site.id` stays the first Tesla ID seen, not a new generated ID. Changing every row and foreign key would add risk and no benefit.
- No owner role. The connection user is plumbing, never shown as "the owner".
- The connection never moves back automatically after a failover.
- An empty product list removes memberships immediately.
- A dead grant is removed after 14 days when another member's works. A forgotten password reset can therefore remove someone's
  TRMNL device, which I accepted to avoid a former owner keeping a live view.
- A sole member removed by Tesla who later returns gets a fresh site, with the old row left to Q3. Tracking former members for
  this rare case isn't worth the extra state.
- `commands_denied_at` expires after 7 days for restore ordering.
- Merging existing duplicates is an admin script, not automatic.
- Legacy `site_auth` tokens with no `sub` keep their claims path. The 30-day cap means none should remain, so removing that
  branch is a separate cleanup.
