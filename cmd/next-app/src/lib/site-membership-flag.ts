/** The shared-site cutover is opt-in until account deletion supports members. */
export function siteMembershipEnabled(): boolean {
    return process.env.SITE_MEMBERSHIP_ENABLED === 'true';
}

/**
 * A test account listed in `ISOLATED_TEST_USER_IDS` (comma-separated `User.id`s, which come from
 * the verified Tesla `sub`) gets its own site on sign-in instead of joining the Powerwall's
 * existing members, so a Powerwall shared with it rehearses a brand-new user. Never on in
 * production. See docs/dev-database-copy.md.
 */
export function isIsolatedTestAccount(userId: string): boolean {
    if (process.env.VERCEL_ENV === 'production' || !userId) return false;
    const ids = (process.env.ISOLATED_TEST_USER_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
    return ids.includes(userId);
}
