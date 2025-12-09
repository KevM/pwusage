
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
            refresh_token: refreshToken,
            scope: 'openid email offline_access'
        })
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Failed to refresh token: ${response.status} ${body}`);
    }

    return response.json();
}
