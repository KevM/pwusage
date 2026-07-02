import { TeslaAuthError } from './tesla-client';

export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token: string }> {
    const url = 'https://auth.tesla.com/oauth2/v3/token';
    const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || 'ownerapi';

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: process.env.TESLA_OAUTH_SECRET,
            refresh_token: refreshToken,
            scope: 'openid email offline_access'
        })
    });

    if (!response.ok) {
        const body = await response.text();
        if (
            response.status === 401 ||
            response.status === 400 ||
            body.includes('invalid_grant') ||
            body.includes('login_required')
        ) {
            throw new TeslaAuthError(`Failed to refresh token: ${response.status} ${body}`, response.status);
        }
        throw new Error(`Failed to refresh token: ${response.status} ${body}`);
    }

    return response.json();
}
