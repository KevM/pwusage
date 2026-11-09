/** The shared-site cutover is opt-in until account deletion supports members. */
export function siteMembershipEnabled(): boolean {
    return process.env.SITE_MEMBERSHIP_ENABLED === 'true';
}
