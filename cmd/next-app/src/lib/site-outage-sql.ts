import { siteMembershipEnabled } from './site-membership-flag';

/** The latest access restoration may belong to the current account or a site failover. */
export function siteAuthRestoredSql(): string {
    return siteMembershipEnabled()
        ? 'GREATEST(u.auth_restored_at, s.connection_restored_at)'
        : 'u.auth_restored_at';
}

export function siteAuthLostSql(): string {
    return siteMembershipEnabled()
        ? `CASE WHEN s.connection_restored_at IS NOT NULL
                  AND (u.auth_restored_at IS NULL OR s.connection_restored_at >= u.auth_restored_at)
                THEN s.connection_lost_at ELSE u.auth_lost_at END`
        : 'u.auth_lost_at';
}

export function siteConnectionUserSql(): string {
    return siteMembershipEnabled() ? 's.tesla_connection_user_id' : 's.user_id';
}
