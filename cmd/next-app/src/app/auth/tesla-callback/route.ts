import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { EnergyRepo } from '@/lib/energy-repo';
import { pool } from '@/lib/db';


export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (!code || !state) {
        return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    const cookieStore = await cookies();
    const savedState = cookieStore.get('auth_state')?.value;
    const savedNonce = cookieStore.get('auth_nonce')?.value;
    const savedCallback = cookieStore.get('auth_callback')?.value;

    if (state !== savedState) {
        return NextResponse.json({ error: 'State mismatch' }, { status: 401 });
    }

    // Exchange token
    const tokenResponse = await fetch("https://auth.tesla.com/oauth2/v3/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            client_id: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID!,
            client_secret: process.env.TESLA_OAUTH_SECRET!,
            audience: process.env.PUBLIC_TESLA_OAUTH_AUDIENCE!,
            redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/auth/tesla-callback`,
            grant_type: "authorization_code",
            code: code,
        }),
    });

    if (!tokenResponse.ok) {
        return NextResponse.json({ error: 'Failed to exchange token' }, { status: tokenResponse.status });
    }

    const authData = await tokenResponse.json();

    // Verify nonce
    const decoded = jwt.decode(authData.id_token) as jwt.JwtPayload | null;
    if (!decoded || decoded.nonce !== savedNonce) {
        return NextResponse.json({ error: 'Nonce mismatch' }, { status: 401 });
    }

    // Save tokens
    // cookieStore.set('access_token', authData.access_token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: authData.expires_in, sameSite: 'lax', path: '/' });
    // cookieStore.set('refresh_token', authData.refresh_token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });

    // Update DB (Source of Truth)
    try {
        const { TeslaClient } = await import('@/lib/tesla-client');
        const { Importer } = await import('@/lib/importer');

        // Initialize client with fresh tokens
        const client = new TeslaClient({
            accessToken: authData.access_token,
            refreshToken: authData.refresh_token,
            onTokenUpdate: async () => { } // No-op, we just got them
        });

        // Fetch User Info (Email, Name, etc.)
        let userEmail: string | undefined;
        let userId: string = 'unknown_user';

        try {
            const userInfo = await client.getUserInfo();
            if (userInfo) {
                userEmail = userInfo.email;
                if (userInfo.email) {
                    userId = userInfo.email; // Use email as ID if available and stable? 
                    // Actually, let's stick to the previous logic IF possible, but 'sub' from ID token is safer for ID.
                    // But for EMAIL, definitely use this.
                }
            }
        } catch (e) {
            console.error('[AuthCallback] Failed to fetch user info:', e);
        }

        // Fallback to ID Token for ID if valid
        const idTokenDecoded = jwt.decode(authData.id_token) as { sub?: string; email?: string } | null;
        if (!userEmail && idTokenDecoded?.email) {
            userEmail = idTokenDecoded.email;
        }

        // Use 'sub' as stable ID if available, otherwise email
        if (idTokenDecoded?.sub) {
            userId = idTokenDecoded.sub;
        } else if (userEmail) {
            userId = userEmail;
        }

        // Fetch products directly from API to find NEW sites
        console.log('[AuthCallback] Fetching products to ensure sites exist in DB...');
        const products = await client.getProducts();

        // Upsert User
        await pool.query(`
            INSERT INTO "User" (id, email, access_token, refresh_token, token_expires_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
                access_token = EXCLUDED.access_token,
                refresh_token = EXCLUDED.refresh_token,
                email = COALESCE(EXCLUDED.email, "User".email)
        `, [userId, userEmail, authData.access_token, authData.refresh_token, Date.now() + (authData.expires_in * 1000)]);

        // Retrieve Roles immediately
        const userRes = await pool.query('SELECT roles FROM "User" WHERE id = $1', [userId]);
        const roles = userRes.rows[0]?.roles || [];

        if (products.length > 0 || roles.includes('admin')) {
            const importer = new Importer(client);
            const repo = new EnergyRepo();
            const siteIds: string[] = [];

            for (const product of products) {
                if (!product.energy_site_id) {
                    continue;
                }
                const siteId = product.energy_site_id.toString();
                siteIds.push(siteId);

                await importer.ensureSite(siteId);
                await pool.query('UPDATE "Site" SET user_id = $1 WHERE id = $2', [userId, siteId]);
                await repo.updateSiteTokens(siteId, authData.access_token, authData.refresh_token);
                await repo.releaseRefreshLock(siteId);
                console.log(`[AuthCallback] Linked site ${siteId} to User ${userId} and updated tokens.`);
            }

            // Generate verified site token
            const { signSiteToken, COOKIE_MAX_AGE_SECONDS } = await import('@/lib/auth-jwt');
            const siteToken = signSiteToken(siteIds, roles, userId);

            // Set 24h cookie
            cookieStore.set('site_auth', siteToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: COOKIE_MAX_AGE_SECONDS,
                path: '/'
            });
            console.log('[AuthCallback] Set site_auth token.');
        }
    } catch (dbError) {
        console.error('[AuthCallback] Failed to update/import sites in DB:', dbError);
        // Don't fail the request, just log. Cookies are still set.
    }

    // Clean up auth cookies
    cookieStore.delete('auth_state');
    cookieStore.delete('auth_nonce');
    cookieStore.delete('auth_callback');

    if (savedCallback) {
        if (savedCallback.startsWith('/')) {
            redirect(savedCallback);
        } else {
            redirect(`${savedCallback}?auth=${authData.access_token}&refresh=${authData.refresh_token}&id=${authData.id_token}`);
        }
    } else {
        redirect('/');
    }
}
