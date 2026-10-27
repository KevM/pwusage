import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { createCipheriv, createHash, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { list, get } from '@vercel/blob';

// One-off read-only export. The private key stays on the rehearsal machine.
const token = process.env.BACKUP_BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error('Private backup credential is unavailable');
const found = await list({ token, prefix: 'db-backup/daily/backup-daily-2026-10-27_15-27-28', limit: 10 });
if (found.blobs.length !== 1) throw new Error('Expected exactly one matching daily backup');
const metadata = found.blobs[0];
const result = await get(metadata.pathname, { token, access: 'private' });
if (result?.statusCode !== 200) throw new Error('Existing backup could not be read');
const chunks = [];
for await (const chunk of result.stream) chunks.push(chunk);
const zip = Buffer.concat(chunks);
if (zip.length !== metadata.size) throw new Error('Downloaded backup length mismatch');
const publicKey = await readFile(new URL('./rehearsal-public.pem', import.meta.url), 'utf8');
const key = randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(zip), cipher.final()]);
const envelope = {
  pathname: metadata.pathname, bytes: zip.length, zipSha256: createHash('sha256').update(zip).digest('hex'),
  wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
  iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'),
};
await writeFile('backup-rehearsal.enc', encrypted, { mode: 0o600 });
await writeFile('backup-rehearsal-envelope.json', JSON.stringify(envelope, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ pathname: envelope.pathname, bytes: envelope.bytes, zipSha256: envelope.zipSha256, encrypted: true }));
