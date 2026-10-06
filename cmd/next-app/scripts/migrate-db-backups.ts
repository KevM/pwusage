import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pathToFileURL } from 'node:url';
import { list, put, type ListBlobResultBlob } from '@vercel/blob';

const PREFIX = 'db-backup/';
const SOURCE_STORE = 'cPW5Yd7jJeDcncac';
const DESTINATION_STORE = 'f5g1DhGjvkJh1krH';

interface MigrationOptions {
    sourceToken: string | undefined;
    destinationToken: string | undefined;
    apply?: boolean;
    log?: (message: string) => void;
}
interface MigrationResult { planned: number; copied: number; verifiedExisting: number }
interface Fingerprint { size: number; sha256: string }

function requireToken(token: string | undefined, store: string, variable: string, name: string): string {
    if (!token) throw new Error(`${variable} is required`);
    if (!token.toLowerCase().startsWith(`vercel_blob_rw_${store.toLowerCase()}_`)) {
        throw new Error(`${variable} must belong to ${name}`);
    }
    return token;
}

function validateUrl(url: string, store: string, access: 'public' | 'private'): void {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.host !== `${store.toLowerCase()}.${access}.blob.vercel-storage.com`
        || parsed.username || parsed.password || !parsed.pathname.startsWith(`/${PREFIX}`)) {
        throw new Error('Unexpected blob URL');
    }
}

async function inventory(token: string, store: string, access: 'public' | 'private'): Promise<Map<string, ListBlobResultBlob>> {
    const blobs = new Map<string, ListBlobResultBlob>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await list({ token, prefix: PREFIX, limit: 1000, cursor });
        for (const blob of page.blobs) {
            validateUrl(blob.url, store, access);
            if (blob.pathname.endsWith('/') && blob.size === 0) continue;
            if (!blob.pathname.startsWith(PREFIX) || blobs.has(blob.pathname)) throw new Error('Unexpected backup inventory');
            blobs.set(blob.pathname, blob);
        }
        if (!page.hasMore) break;
        if (!page.cursor || cursors.has(page.cursor)) throw new Error('Invalid storage pagination cursor');
        cursors.add(page.cursor);
        cursor = page.cursor;
    } while (true);
    return blobs;
}

async function readBlob(url: string, token?: string): Promise<Response> {
    const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new Error(`Backup download failed (HTTP ${response.status})`);
    return response;
}

async function downloadSource(response: Response, filename: string): Promise<Fingerprint> {
    const hash = createHash('sha256');
    let size = 0;
    const digest = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
            size += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
        },
    });
    await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
        digest, createWriteStream(filename, { mode: 0o600, flags: 'wx' }),
    );
    return { size, sha256: hash.digest('hex') };
}

async function verifyDestination(url: string, token: string, expected: Fingerprint, pathname: string): Promise<void> {
    validateUrl(url, DESTINATION_STORE, 'private');
    const response = await readBlob(url, token);
    const reader = response.body!.getReader();
    const hash = createHash('sha256');
    let size = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            hash.update(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) {
        throw new Error(`Verification failed for ${pathname}: destination bytes differ from source`);
    }
}

/** Copy only database backups; public originals are never deleted or overwritten. */
export async function migrateDatabaseBackups(options: MigrationOptions): Promise<MigrationResult> {
    const sourceToken = requireToken(options.sourceToken, SOURCE_STORE, 'BLOB_READ_WRITE_TOKEN', 'pwusage-blob');
    const destinationToken = requireToken(options.destinationToken, DESTINATION_STORE, 'BACKUP_BLOB_READ_WRITE_TOKEN', 'pwusage-db-backups');
    const log = options.log ?? console.log;
    const sources = await inventory(sourceToken, SOURCE_STORE, 'public');
    const destinations = await inventory(destinationToken, DESTINATION_STORE, 'private');
    const result: MigrationResult = { planned: sources.size, copied: 0, verifiedExisting: 0 };
    log(`${options.apply ? 'APPLY' : 'DRY RUN'}: ${sources.size} backups in pwusage-blob/${PREFIX} -> pwusage-db-backups/${PREFIX}`);
    for (const [pathname, source] of sources) {
        const existing = destinations.get(pathname);
        if (!options.apply) {
            log(`${existing ? 'Would verify existing' : 'Would copy'}: ${pathname} (${source.size} bytes)`);
            continue;
        }
        const directory = await mkdtemp(join(tmpdir(), 'pwusage-backup-migration-'));
        const filename = join(directory, 'backup');
        try {
            const response = await readBlob(source.url);
            const fingerprint = await downloadSource(response, filename);
            if (fingerprint.size !== source.size) throw new Error(`Source size changed for ${pathname}; rerun to refresh inventory`);
            let url = existing?.url;
            if (!url) {
                const body = createReadStream(filename);
                try {
                    const uploaded = await put(pathname, body, {
                        access: 'private', token: destinationToken, addRandomSuffix: false, allowOverwrite: false,
                        multipart: true, contentType: response.headers.get('content-type') ?? 'application/octet-stream',
                    });
                    if (uploaded.pathname !== pathname) throw new Error(`Unexpected uploaded pathname for ${pathname}`);
                    url = uploaded.url;
                } finally {
                    body.destroy();
                }
            }
            await verifyDestination(url, destinationToken, fingerprint, pathname);
            if (existing) result.verifiedExisting++; else result.copied++;
            log(`Verified ${existing ? 'existing copy' : 'new copy'}: ${pathname} (${fingerprint.size} bytes, SHA-256 ${fingerprint.sha256})`);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
    log(`Finished: ${result.copied} copied, ${result.verifiedExisting} existing copies verified. Public originals retained.`);
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('Usage: npx tsx scripts/migrate-db-backups.ts [--dry-run | --apply]\nRequires BLOB_READ_WRITE_TOKEN and BACKUP_BLOB_READ_WRITE_TOKEN. Defaults to dry run; never deletes originals.');
    } else if (args.some(arg => arg !== '--apply' && arg !== '--dry-run') || (args.includes('--apply') && args.includes('--dry-run'))) {
        console.error('Use --dry-run or --apply. See --help.');
        process.exitCode = 1;
    } else {
        migrateDatabaseBackups({ sourceToken: process.env.BLOB_READ_WRITE_TOKEN, destinationToken: process.env.BACKUP_BLOB_READ_WRITE_TOKEN, apply: args.includes('--apply') })
            .catch((error: unknown) => {
                let message = error instanceof Error ? error.message : 'Backup migration failed';
                for (const token of [process.env.BLOB_READ_WRITE_TOKEN, process.env.BACKUP_BLOB_READ_WRITE_TOKEN]) {
                    if (token) message = message.replaceAll(token, '[REDACTED]');
                }
                console.error(message);
                process.exitCode = 1;
            });
    }
}
