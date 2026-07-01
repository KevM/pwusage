import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import crypto from 'crypto';

const TRMNL_JWKS_URI = 'https://trmnl.com/.well-known/jwks.json';

const client = jwksClient({
    jwksUri: TRMNL_JWKS_URI,
    cache: true,
    rateLimit: true,
});

export interface VerifiedTrmnlTokenPayload extends jwt.JwtPayload {
    sub: string;
    plugin_setting_id?: number | string;
    user?: {
        plugin_setting_id?: number | string;
    };
}

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
    client.getSigningKey(header.kid, function (err: Error | null, key: { getPublicKey: () => string } | undefined) {
        if (err) {
            callback(err, undefined);
            return;
        }
        const signingKey = key?.getPublicKey();
        callback(null, signingKey);
    });
}

export function safeTimingSafeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyTrmnlToken(token: string, expectedUuid: string): Promise<VerifiedTrmnlTokenPayload> {
    return new Promise((resolve, reject) => {
        jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
            if (err) {
                return reject(err);
            }
            const payload = decoded as VerifiedTrmnlTokenPayload;
            if (payload.sub !== expectedUuid) {
                return reject(new Error('Token subject does not match UUID'));
            }
            resolve(payload);
        });
    });
}

export async function verifyTrmnlRequestAuth(
    token: string,
    uuid: string,
    installation: { access_token?: string | null } | null
): Promise<boolean> {
    if (!token) return false;
    if (installation?.access_token && safeTimingSafeEqual(token, installation.access_token)) {
        return true;
    }
    try {
        await verifyTrmnlToken(token, uuid);
        return true;
    } catch (err) {
        console.warn(`[verifyTrmnlRequestAuth] Token verification failed for ${uuid}:`, err);
        return false;
    }
}

