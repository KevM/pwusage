import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadStream } from 'node:fs';
import { migrateDatabaseBackups } from './migrate-db-backups';

const { listMock, putMock } = vi.hoisted(() => ({ listMock: vi.fn(), putMock: vi.fn() }));
vi.mock('@vercel/blob', () => ({ list: listMock, put: putMock }));

const sourceToken = 'vercel_blob_rw_cPW5Yd7jJeDcncac_source';
const destinationToken = 'vercel_blob_rw_f5g1DhGjvkJh1krH_destination';
const options = { sourceToken, destinationToken, log: vi.fn() };
const sourceUrl = 'https://cpw5yd7jjedcncac.public.blob.vercel-storage.com/db-backup/backup.zip';
const destinationUrl = 'https://f5g1dhgjvkjh1krh.private.blob.vercel-storage.com/db-backup/backup.zip';
const blob = (url: string, pathname = 'db-backup/backup.zip') => ({
    url, pathname, size: 6, downloadUrl: url, uploadedAt: new Date(), etag: 'fixture',
});
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    listMock.mockResolvedValueOnce({ blobs: [blob(sourceUrl)], hasMore: false })
        .mockResolvedValueOnce({ blobs: [], hasMore: false });
    fetchMock.mockImplementation(async () => new Response('backup'));
    putMock.mockResolvedValue(blob(destinationUrl));
});
afterEach(() => vi.unstubAllGlobals());

it('defaults to a dry run and lists every page without reading or uploading backup bytes', async () => {
    listMock.mockReset().mockResolvedValueOnce({ blobs: [blob(sourceUrl)], hasMore: true, cursor: 'page2' })
        .mockResolvedValueOnce({ blobs: [], hasMore: false })
        .mockResolvedValueOnce({ blobs: [], hasMore: false });
    expect(await migrateDatabaseBackups(options)).toEqual({ planned: 1, copied: 0, verifiedExisting: 0 });
    expect(listMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'page2', prefix: 'db-backup/', token: sourceToken }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
});

it('uploads exact bytes privately with the same path and verifies the authenticated destination', async () => {
    putMock.mockImplementationOnce(async (pathname: string, body: ReadStream, settings: Record<string, unknown>) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
        expect(Buffer.concat(chunks).toString()).toBe('backup');
        expect(pathname).toBe('db-backup/backup.zip');
        expect(settings).toMatchObject({ access: 'private', token: destinationToken, addRandomSuffix: false, allowOverwrite: false });
        return blob(destinationUrl);
    });
    expect(await migrateDatabaseBackups({ ...options, apply: true })).toEqual({ planned: 1, copied: 1, verifiedExisting: 0 });
    expect(fetchMock).toHaveBeenCalledWith(destinationUrl, expect.objectContaining({
        headers: { Authorization: `Bearer ${destinationToken}` }, redirect: 'error',
    }));
});

it('verifies identical existing copies on reruns without overwriting', async () => {
    listMock.mockReset().mockResolvedValueOnce({ blobs: [blob(sourceUrl)], hasMore: false })
        .mockResolvedValueOnce({ blobs: [blob(destinationUrl)], hasMore: false });
    expect(await migrateDatabaseBackups({ ...options, apply: true })).toEqual({ planned: 1, copied: 0, verifiedExisting: 1 });
    expect(putMock).not.toHaveBeenCalled();
});

it('rejects a corrupt existing copy even when its size matches', async () => {
    listMock.mockReset().mockResolvedValueOnce({ blobs: [blob(sourceUrl)], hasMore: false })
        .mockResolvedValueOnce({ blobs: [blob(destinationUrl)], hasMore: false });
    fetchMock.mockImplementation(async (url) => new Response(String(url) === sourceUrl ? 'backup' : 'broken'));
    await expect(migrateDatabaseBackups({ ...options, apply: true })).rejects.toThrow('Verification failed');
    expect(putMock).not.toHaveBeenCalled();
});

it('rejects a corrupt newly uploaded copy', async () => {
    fetchMock.mockImplementation(async (url) => new Response(String(url) === sourceUrl ? 'backup' : 'broken'));
    await expect(migrateDatabaseBackups({ ...options, apply: true })).rejects.toThrow('Verification failed');
});

it('stops on HTTP errors before uploading', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(migrateDatabaseBackups({ ...options, apply: true })).rejects.toThrow('503');
    expect(putMock).not.toHaveBeenCalled();
});

it('rejects missing or swapped store credentials before contacting storage', async () => {
    await expect(migrateDatabaseBackups({ ...options, sourceToken: undefined })).rejects.toThrow('BLOB_READ_WRITE_TOKEN');
    await expect(migrateDatabaseBackups({ ...options, destinationToken: sourceToken })).rejects.toThrow('pwusage-db-backups');
    expect(listMock).not.toHaveBeenCalled();
});

it('rejects unexpected destination URLs before sending credentials to them', async () => {
    putMock.mockResolvedValueOnce(blob('https://unexpected.example/backup.zip'));
    await expect(migrateDatabaseBackups({ ...options, apply: true })).rejects.toThrow('Unexpected blob URL');
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('propagates upload failures and does not claim verification', async () => {
    putMock.mockRejectedValueOnce(new Error('Upload unavailable'));
    await expect(migrateDatabaseBackups({ ...options, apply: true })).rejects.toThrow('Upload unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('stops before uploading when the source size differs from its inventory', async () => {
    fetchMock.mockResolvedValueOnce(new Response('truncated'));
    await expect(migrateDatabaseBackups({ ...options, apply: true })).rejects.toThrow('Source size changed');
    expect(putMock).not.toHaveBeenCalled();
});

it('rejects broken pagination before uploading anything', async () => {
    listMock.mockReset().mockResolvedValueOnce({ blobs: [blob(sourceUrl)], hasMore: true });
    await expect(migrateDatabaseBackups({ ...options, apply: true })).rejects.toThrow('pagination cursor');
    expect(putMock).not.toHaveBeenCalled();
});

it('ignores zero-byte folder markers in the live backup prefix', async () => {
    listMock.mockReset().mockResolvedValueOnce({ blobs: [{ ...blob(sourceUrl, 'db-backup/'), size: 0 }], hasMore: false })
        .mockResolvedValueOnce({ blobs: [], hasMore: false });
    expect(await migrateDatabaseBackups(options)).toEqual({ planned: 0, copied: 0, verifiedExisting: 0 });
});
