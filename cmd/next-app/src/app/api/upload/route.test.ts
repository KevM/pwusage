import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isUserAdmin: vi.fn(),
    put: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({
    isUserAdmin: mocks.isUserAdmin
}));

vi.mock('@vercel/blob', () => ({
    put: mocks.put
}));

import { POST } from './route';

describe('POST /api/upload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 401 when non-admin attempts upload', async () => {
        mocks.isUserAdmin.mockResolvedValue(false);

        const req = new Request('http://localhost/api/upload?filename=image.png', {
            method: 'POST',
            body: 'file-content'
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
    });

    it('returns 400 when filename or request body is missing', async () => {
        mocks.isUserAdmin.mockResolvedValue(true);

        // Missing filename
        const reqNoFile = new Request('http://localhost/api/upload', {
            method: 'POST',
            body: 'file-content'
        });
        const resNoFile = await POST(reqNoFile);
        expect(resNoFile.status).toBe(400);

        // Missing body
        const reqNoBody = new Request('http://localhost/api/upload?filename=test.png', {
            method: 'POST'
        });
        const resNoBody = await POST(reqNoBody);
        expect(resNoBody.status).toBe(400);
    });

    it('rejects path traversal or path-like filenames like ../x', async () => {
        mocks.isUserAdmin.mockResolvedValue(true);

        const invalidFilenames = ['../evil.png', 'folder/evil.png', '..\\evil.png'];

        for (const filename of invalidFilenames) {
            const req = new Request(`http://localhost/api/upload?filename=${encodeURIComponent(filename)}`, {
                method: 'POST',
                body: 'file-content'
            });
            const res = await POST(req);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Invalid filename');
        }
    });

    it('successfully uploads valid file for admin user', async () => {
        mocks.isUserAdmin.mockResolvedValue(true);
        mocks.put.mockResolvedValue({ url: 'https://blob.vercel-storage.com/system-announcements/chart.png' });

        const req = new Request('http://localhost/api/upload?filename=chart.png', {
            method: 'POST',
            body: 'image-binary-data'
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.url).toContain('chart.png');
        expect(mocks.put).toHaveBeenCalledWith('system-announcements/chart.png', expect.anything(), { access: 'public' });
    });
});
