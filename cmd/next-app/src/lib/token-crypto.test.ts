import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    TokenCryptoError,
    decryptToken,
    encryptToken,
    isEncryptedToken,
    sealToken,
    tokenFingerprint,
} from './token-crypto';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const FP_KEY = Buffer.alloc(32, 9).toString('base64');

function setEnv(keys: string | undefined, fp: string | null | undefined = FP_KEY) {
    if (keys === undefined) delete process.env.TOKEN_ENCRYPTION_KEYS;
    else process.env.TOKEN_ENCRYPTION_KEYS = keys;
    if (fp === null || fp === undefined) delete process.env.TOKEN_FINGERPRINT_KEY;
    else process.env.TOKEN_FINGERPRINT_KEY = fp;
}

describe('token-crypto', () => {
    const saved = { keys: process.env.TOKEN_ENCRYPTION_KEYS, fp: process.env.TOKEN_FINGERPRINT_KEY };
    beforeEach(() => setEnv(`k1:${KEY_A}`));
    afterEach(() => setEnv(saved.keys, saved.fp));

    it('round-trips and uses the versioned envelope', () => {
        const enc = encryptToken('secret-token', 'refresh_token', 'user-1');
        expect(enc).toMatch(/^enc:v1:k1:[^:]+:[^:]+$/);
        expect(enc).not.toContain('secret-token');
        expect(decryptToken(enc, 'refresh_token', 'user-1')).toBe('secret-token');
    });

    it('uses a random IV so equal plaintexts differ', () => {
        expect(encryptToken('x', 'access_token', 'u')).not.toBe(encryptToken('x', 'access_token', 'u'));
    });

    it('rejects tampered ciphertext', () => {
        const enc = encryptToken('secret-token', 'refresh_token', 'user-1');
        const parts = enc.split(':');
        const ct = Buffer.from(parts[4], 'base64');
        ct[0] ^= 1;
        parts[4] = ct.toString('base64');
        expect(() => decryptToken(parts.join(':'), 'refresh_token', 'user-1')).toThrow();
    });

    it('rejects a different row or column (AAD binding)', () => {
        const enc = encryptToken('secret-token', 'refresh_token', 'user-1');
        expect(() => decryptToken(enc, 'refresh_token', 'user-2')).toThrow();
        expect(() => decryptToken(enc, 'access_token', 'user-1')).toThrow();
    });

    it('passes plaintext through on read for rollout, and preserves null', () => {
        expect(decryptToken('plain-token', 'access_token', 'user-1')).toBe('plain-token');
        expect(decryptToken(null, 'access_token', 'user-1')).toBeNull();
        expect(decryptToken('', 'access_token', 'user-1')).toBe('');
        expect(isEncryptedToken('plain-token')).toBe(false);
    });

    it('rotates keys: first is active, older keys still decrypt', () => {
        const old = encryptToken('t', 'access_token', 'u');
        setEnv(`k2:${KEY_B},k1:${KEY_A}`);
        const fresh = encryptToken('t', 'access_token', 'u');
        expect(fresh).toMatch(/^enc:v1:k2:/);
        expect(decryptToken(old, 'access_token', 'u')).toBe('t');
        expect(decryptToken(fresh, 'access_token', 'u')).toBe('t');
        setEnv(`k2:${KEY_B}`);
        expect(() => decryptToken(old, 'access_token', 'u')).toThrow(/k1/);
    });

    it('fails closed when no key is configured or a key is malformed', () => {
        setEnv(undefined);
        expect(() => encryptToken('t', 'access_token', 'u')).toThrow(/TOKEN_ENCRYPTION_KEYS/);
        setEnv(`k1:${Buffer.alloc(16).toString('base64')}`);
        expect(() => encryptToken('t', 'access_token', 'u')).toThrow(/32 bytes/);
    });

    it('still reads plaintext when no key is configured', () => {
        setEnv(undefined);
        expect(decryptToken('plain', 'access_token', 'u')).toBe('plain');
    });

    it('tolerates surrounding whitespace or quotes in the env value', () => {
        setEnv(`  "k1:${KEY_A}"  `);
        const enc = encryptToken('t', 'access_token', 'u');
        expect(decryptToken(enc, 'access_token', 'u')).toBe('t');
    });

    it('rejects keys that are not canonical base64', () => {
        // A typo that Buffer.from would silently skip still decodes to 32 bytes.
        setEnv(`k1:${KEY_A.slice(0, 10)}!${KEY_A.slice(10)}`);
        expect(() => encryptToken('t', 'access_token', 'u')).toThrow(/base64/);
        setEnv(`k1:${KEY_A.replace(/=$/, '')}`);
        expect(() => encryptToken('t', 'access_token', 'u')).toThrow(/base64/);
        setEnv(undefined, `${FP_KEY}!`);
        expect(() => tokenFingerprint('x')).toThrow(/base64/);
    });

    it('picks up env changes between calls despite parse caching', () => {
        const a = encryptToken('t', 'access_token', 'u');
        setEnv(`k2:${KEY_B}`);
        expect(encryptToken('t', 'access_token', 'u')).toMatch(/^enc:v1:k2:/);
        expect(() => decryptToken(a, 'access_token', 'u')).toThrow(/k1/);
    });

    describe('error codes (exported to logs, which drop error messages)', () => {
        const codeOf = (fn: () => unknown) => {
            try { fn(); } catch (e) { return e instanceof TokenCryptoError ? e.code : `not-TokenCryptoError:${String(e)}`; }
            return 'did-not-throw';
        };

        it('reports why decryption failed', () => {
            const enc = encryptToken('t', 'access_token', 'u');
            setEnv(`k2:${KEY_B}`);
            expect(codeOf(() => decryptToken(enc, 'access_token', 'u'))).toBe('KEY_ID_UNKNOWN');
            setEnv(`k1:${KEY_A}`);
            expect(codeOf(() => decryptToken(enc, 'access_token', 'other'))).toBe('DECRYPT_FAILED');
            expect(codeOf(() => decryptToken('enc:v1:k1:bad', 'access_token', 'u'))).toBe('ENVELOPE_MALFORMED');
        });

        it('reports configuration problems', () => {
            setEnv(undefined, null);
            expect(codeOf(() => encryptToken('t', 'access_token', 'u'))).toBe('KEYS_NOT_CONFIGURED');
            expect(codeOf(() => tokenFingerprint('t'))).toBe('FINGERPRINT_KEY_NOT_CONFIGURED');
            setEnv(`k1:${Buffer.alloc(16).toString('base64')}`);
            expect(codeOf(() => encryptToken('t', 'access_token', 'u'))).toBe('KEY_INVALID');
        });
    });

    describe('sealToken', () => {
        it('encrypts plaintext, leaves null/empty and active-key envelopes untouched', () => {
            expect(sealToken(null, 'access_token', 'u')).toBeNull();
            expect(sealToken('', 'access_token', 'u')).toBe('');
            const enc = sealToken('plain', 'access_token', 'u');
            expect(isEncryptedToken(enc)).toBe(true);
            expect(sealToken(enc, 'access_token', 'u')).toBe(enc);
        });

        it('re-encrypts an envelope written under a non-active key', () => {
            const old = encryptToken('t', 'refresh_token', 'u');
            setEnv(`k2:${KEY_B},k1:${KEY_A}`);
            const resealed = sealToken(old, 'refresh_token', 'u');
            expect(resealed).toMatch(/^enc:v1:k2:/);
            expect(decryptToken(resealed, 'refresh_token', 'u')).toBe('t');
        });
    });

    describe('tokenFingerprint', () => {
        it('is deterministic, hex, and not the token', () => {
            const fp = tokenFingerprint('refresh-1');
            expect(fp).toMatch(/^[0-9a-f]{64}$/);
            expect(tokenFingerprint('refresh-1')).toBe(fp);
            expect(tokenFingerprint('refresh-2')).not.toBe(fp);
        });

        it('depends on its own key, not the encryption key', () => {
            const fp = tokenFingerprint('refresh-1');
            setEnv(`k9:${KEY_B}`);
            expect(tokenFingerprint('refresh-1')).toBe(fp);
            setEnv(`k1:${KEY_A}`, Buffer.alloc(32, 7).toString('base64'));
            expect(tokenFingerprint('refresh-1')).not.toBe(fp);
        });

        it('fails closed without a fingerprint key', () => {
            setEnv(`k1:${KEY_A}`, null);
            expect(() => tokenFingerprint('x')).toThrow(/TOKEN_FINGERPRINT_KEY/);
        });
    });
});
