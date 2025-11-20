import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';

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
            redirect_uri: `${process.env.PUBLIC_WEBAPP_BASE_URL}/auth/tesla-callback`,
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

    // Clean up auth cookies
    cookieStore.delete('auth_state');
    cookieStore.delete('auth_nonce');
    cookieStore.delete('auth_callback');

    if (savedCallback) {
        redirect(`${savedCallback}?auth=${authData.access_token}&refresh=${authData.refresh_token}&id=${authData.id_token}`);
    } else {
        redirect('/');
    }
}
