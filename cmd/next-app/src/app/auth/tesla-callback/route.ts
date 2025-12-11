import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { EnergyRepo } from '@/lib/energy-repo';


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
    cookieStore.set('access_token', authData.access_token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: authData.expires_in });
    cookieStore.set('refresh_token', authData.refresh_token, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });

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

        // Fetch products directly from API to find NEW sites
        console.log('[AuthCallback] Fetching products to ensure sites exist in DB...');
        const products = await client.getProducts();

        if (products.length > 0) {
            const importer = new Importer(client);
            const repo = new EnergyRepo();
            const siteIds: string[] = [];

            for (const product of products) {
                const siteId = product.energy_site_id.toString();
                siteIds.push(siteId);
                // Ensure site record exists (synced from API)
                await importer.ensureSite(siteId);
                // Ensure tokens are stored/updated
                await repo.updateSiteTokens(siteId, authData.access_token, authData.refresh_token);
                await repo.releaseRefreshLock(siteId);
                console.log(`[AuthCallback] Ensured site ${siteId} and updated tokens.`);
            }

            // Generate verified site token
            const { signSiteToken } = await import('@/lib/auth-jwt');
            const siteToken = signSiteToken(siteIds);

            // Set 24h cookie (matching our token expiry intent)
            cookieStore.set('site_auth', siteToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: 86400
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
