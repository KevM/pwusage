# Recovery: Auth Status Cache Bug (May 13, 2026)

## Issue
After deploying the `includeTokens` feature at 10:17 AM CT, a caching bug caused some users' accounts to be incorrectly marked as `revoked` when they encountered transient 401 errors from the Tesla API.

**Deployment Time:** May 13, 2026 at 10:17 AM CT

## Symptoms
- Users seeing "Tesla Auth Expired" QR codes
- Trmnl devices showing re-auth prompts
- Users unable to use the app without re-authenticating

## Recovery Steps

### 1. Verify the Issue
Check how many users are currently revoked:
```bash
cd cmd/next-app
psql $DATABASE_URL -c "SELECT COUNT(*) FROM \"User\" WHERE auth_status = 'revoked';"
```

### 2. Dry Run
First, see which users would be affected without making changes:
```bash
npx tsx scripts/recover-revoked-users.ts --dry-run
```

### 3. Execute Recovery
When ready, run the recovery script:
```bash
npx tsx scripts/recover-revoked-users.ts
```

The script will:
- Show all currently revoked users
- Ask for confirmation
- Reset their `auth_status` to `'active'` and `is_active` to `true`

### 4. Verification
Verify the recovery was successful:
```bash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM \"User\" WHERE auth_status = 'revoked';"
```

Expected result: `0` or significantly fewer rows

## Notes
- If any users have legitimately invalid tokens, they will be re-revoked on their next API call
- All changes require confirmation before execution

## Root Cause Fix
The underlying cache validation bug was fixed in this PR. The cache now properly checks both `access_token` and `auth_status` are defined when fetching with `includeTokens`, preventing stale auth status from being served.
