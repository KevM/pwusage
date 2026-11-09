import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Application-level encryption for Tesla tokens stored in `User`.
 *
 * Envelope: `enc:v1:<keyId>:<iv>:<ciphertext+tag>` (base64 segments), AES-256-GCM
 * with AAD `User:<column>:<userId>`, so a ciphertext cannot be moved to another
 * row or column. Keys live in the `TOKEN_ENCRYPTION_KEYS` env var, not the
 * database, so database access or a backup alone cannot decrypt.
 *
 * Reads pass plaintext through so rows not yet backfilled keep working during
 * rollout; writes always encrypt. See Authentication.md.
 */

export type TokenColumn = 'access_token' | 'refresh_token';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface KeyEntry {
    id: string;
    key: Buffer;
}

/** A 32-byte key is exactly 43 base64 characters plus one `=`; anything else is a typo. */
const CANONICAL_KEY_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

function decodeKey(raw: string, label: string): Buffer {
    // Buffer.from skips invalid characters silently, so validate the text first.
    if (!CANONICAL_KEY_BASE64.test(raw)) throw new Error(`${label} must be canonical base64 of 32 bytes`);
    return Buffer.from(raw, 'base64');
}

/** Env values pasted into dashboards often carry whitespace or quotes. */
function cleanEnv(value: string | undefined): string | undefined {
    return value?.trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
}

let parsedKeys: { raw: string; keys: KeyEntry[] } | undefined;

/**
 * `TOKEN_ENCRYPTION_KEYS=id1:base64key,id2:base64key`; the first entry is active.
 * Parsed once per distinct env value: list reads decrypt many rows.
 */
function loadKeys(): KeyEntry[] {
    const raw = cleanEnv(process.env.TOKEN_ENCRYPTION_KEYS);
    if (!raw) throw new Error('TOKEN_ENCRYPTION_KEYS is not set');
    if (parsedKeys?.raw === raw) return parsedKeys.keys;
    const keys = raw.split(',').map(part => {
        const [id, encoded, ...rest] = part.trim().split(':');
        if (!id || !encoded || rest.length) throw new Error('TOKEN_ENCRYPTION_KEYS entries must look like <keyId>:<base64 key>');
        return { id, key: decodeKey(encoded, `TOKEN_ENCRYPTION_KEYS key "${id}"`) };
    });
    parsedKeys = { raw, keys };
    return keys;
}

/** The id that new writes are encrypted under. */
export function activeKeyId(): string {
    return loadKeys()[0].id;
}

function aad(column: TokenColumn, userId: string): Buffer {
    return Buffer.from(`User:${column}:${userId}`, 'utf8');
}

export function isEncryptedToken(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptToken(plaintext: string, column: TokenColumn, userId: string): string {
    const { id, key } = loadKeys()[0];
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(column, userId));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return `${PREFIX}${id}:${iv.toString('base64')}:${ct.toString('base64')}`;
}

/** Null and empty values pass through; unprefixed values are legacy plaintext. */
export function decryptToken<T extends string | null | undefined>(value: T, column: TokenColumn, userId: string): T {
    if (!value || !isEncryptedToken(value)) return value;
    const [keyId, ivB64, ctB64, ...rest] = (value as string).slice(PREFIX.length).split(':');
    if (!keyId || !ivB64 || !ctB64 || rest.length) throw new Error('Malformed encrypted token envelope');
    const entry = loadKeys().find(k => k.id === keyId);
    if (!entry) throw new Error(`No TOKEN_ENCRYPTION_KEYS entry for key id "${keyId}"`);
    const iv = Buffer.from(ivB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    if (iv.length !== IV_BYTES || ct.length < TAG_BYTES) throw new Error('Malformed encrypted token envelope');
    const decipher = createDecipheriv('aes-256-gcm', entry.key, iv);
    decipher.setAAD(aad(column, userId));
    decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_BYTES)), decipher.final()]).toString('utf8') as T;
}

/**
 * Bring a stored value to the current standard: plaintext is encrypted, and an
 * envelope written under a non-active key is re-encrypted under the active one.
 * Null, empty and active-key envelopes come back unchanged. Used by the backfill.
 */
export function sealToken(value: string | null, column: TokenColumn, userId: string): string | null {
    if (!value) return value;
    if (value.startsWith(`${PREFIX}${activeKeyId()}:`)) return value;
    return encryptToken(decryptToken(value, column, userId), column, userId);
}

/**
 * Deterministic HMAC-SHA256 of a token, keyed by `TOKEN_FINGERPRINT_KEY` (separate
 * from the encryption keys). Random-IV ciphertext never matches itself, so the
 * single-use refresh-token compare-and-swap compares this instead.
 */
export function tokenFingerprint(token: string): string {
    const raw = cleanEnv(process.env.TOKEN_FINGERPRINT_KEY);
    if (!raw) throw new Error('TOKEN_FINGERPRINT_KEY is not set');
    return createHmac('sha256', decodeKey(raw, 'TOKEN_FINGERPRINT_KEY')).update(token, 'utf8').digest('hex');
}
