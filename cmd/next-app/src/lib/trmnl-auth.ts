import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const TRMNL_JWKS_URI = 'https://usetrmnl.com/.well-known/jwks.json';

const client = jwksClient({
    jwksUri: TRMNL_JWKS_URI,
    cache: true,
    rateLimit: true,
});

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

export function verifyTrmnlToken(token: string, expectedUuid: string): Promise<void> {
    return new Promise((resolve, reject) => {
        jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
            if (err) {
                return reject(err);
            }
            const payload = decoded as jwt.JwtPayload;
            if (payload.sub !== expectedUuid) {
                return reject(new Error('Token subject does not match UUID'));
            }
            resolve();
        });
    });
}
