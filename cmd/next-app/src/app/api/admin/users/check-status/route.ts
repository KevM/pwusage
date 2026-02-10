import { NextResponse } from 'next/server';
import { UserRepo } from '@/lib/user-repo';
import { TeslaClient } from '@/lib/tesla-client';
import { isUserAdmin } from '@/lib/auth-checks';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Limit for Hobby plan

export async function POST() {
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
        return new NextResponse('Unauthorized', { status: 401 });
    }

    const userRepo = new UserRepo();
    const users = await userRepo.getAllUsers();

    let activeCount = 0;
    let inactiveCount = 0;
    let errorCount = 0;

    interface CheckResult {
        id: string;
        status: string;
        error?: string;
    }

    const results: CheckResult[] = [];

    // Process checks in sequence (or limited concurrency) to avoid rate limits
    for (const user of users) {
        // Skip if no tokens
        if (!user.access_token || !user.refresh_token) {
            await userRepo.updateUserStatus(user.id, 'no_token', false);
            results.push({ id: user.id, status: 'no_token' });
            inactiveCount++;
            continue;
        }

        // Get user's sites to test with
        const { pool } = await import('@/lib/db');
        const sitesRes = await pool.query('SELECT id FROM "Site" WHERE user_id = $1 LIMIT 1', [user.id]);

        if (sitesRes.rows.length === 0) {
            // No sites - can't verify credentials
            await userRepo.updateUserStatus(user.id, 'no_sites', false);
            results.push({ id: user.id, status: 'no_sites' });
            inactiveCount++;
            continue;
        }

        const siteId = sitesRes.rows[0].id;

        try {
            // Attempt to use the token
            const client = new TeslaClient({
                accessToken: user.access_token,
                refreshToken: user.refresh_token,
                // We provide a token refresh handler that just returns the new tokens
                // The TeslaClient will attempt refresh internally on 401
                tokenRefreshHandler: async (refreshToken) => {
                    const { refreshAccessToken } = await import('@/lib/tesla-auth');
                    return refreshAccessToken(refreshToken);
                },
                onTokenUpdate: async (newAccess, newRefresh) => {
                    // We need to update the user with new tokens if they refresh
                    // But UserRepo updateSiteTokens updates by site... 
                    // We probably need a direct updateUserTokens method or use the existing one if we had a siteId.
                    // IMPORTANT: The `onTokenUpdate` in TeslaClient is void.
                    // Ideally we should persist the new tokens.
                    // For now, let's rely on the client refreshing and proceeding.
                    // To properly save, we'd need to update `User` table directly.

                    // We will implement a quick direct update here to ensure persistence
                    const { pool } = await import('@/lib/db');
                    await pool.query('UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3', [newAccess, newRefresh, user.id]);
                    console.log(`[CheckStatus] Refreshed tokens for user ${user.id}`);
                }
            });

            // Use site-specific API call instead of getUserInfo
            // This matches the actual API calls used by the application
            await client.getLiveStatus(siteId);

            // If we get here, it's active
            await userRepo.updateUserStatus(user.id, 'active', true);
            results.push({ id: user.id, status: 'active' });
            activeCount++;

        } catch (err: unknown) {
            console.error(`[CheckStatus] Error checking user ${user.id}:`, err);

            let status = 'error';
            const errorMsg = err instanceof Error ? err.message : String(err);

            // If it's an auth error, mark inactive.
            if (errorMsg.includes('401') || errorMsg.includes('login_required')) {
                status = 'revoked'; // or 'expired' if refresh failed
            }

            // For 'error', we might want to manually review, but 'revoked' is clear.
            await userRepo.updateUserStatus(user.id, status, false);
            results.push({ id: user.id, status: status, error: errorMsg });
            inactiveCount++;
            // Increment errorCount if it's an error, or strictly if it's 'error' status? 
            // The JSON summary has 'errors'. Let's count actual errors/exceptions as errors.
            // But if we classified it as 'revoked', is it an error? 
            // The user wanted to detect inactive.
            // Let's count 'error' status as errorCount, 'revoked' as inactiveCount.
            if (status === 'error') {
                errorCount++;
            }
        }

        // Brief pause to be nice to API
        await new Promise(r => setTimeout(r, 200));
    }

    return NextResponse.json({
        success: true,
        summary: {
            total: users.length,
            active: activeCount,
            inactive: inactiveCount,
            errors: errorCount
        },
        items: results
    });
}
