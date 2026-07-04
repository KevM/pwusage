import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isUserAdmin: vi.fn(),
    getCurrentUser: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getById: vi.fn(),
    getAll: vi.fn(),
    getLatest: vi.fn(),
    sendDiscordAnnouncement: vi.fn(),
    updateDiscordAnnouncement: vi.fn(),
    deleteDiscordAnnouncement: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({
    isUserAdmin: mocks.isUserAdmin,
    getCurrentUser: mocks.getCurrentUser,
}));

vi.mock('@/lib/announcement-repo', () => ({
    AnnouncementRepo: class {
        create = mocks.create;
        update = mocks.update;
        delete = mocks.delete;
        getById = mocks.getById;
        getAll = mocks.getAll;
        getLatest = mocks.getLatest;
    }
}));

vi.mock('@/lib/discord', () => ({
    sendDiscordAnnouncement: mocks.sendDiscordAnnouncement,
    updateDiscordAnnouncement: mocks.updateDiscordAnnouncement,
    deleteDiscordAnnouncement: mocks.deleteDiscordAnnouncement,
}));

import { GET, POST, PUT, DELETE } from './route';

describe('/api/announcements', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('GET', () => {
        it('returns all announcements or latest based on query param', async () => {
            mocks.getAll.mockResolvedValue([{ id: '1', title: 'Test' }]);
            const req = new Request('http://localhost/api/announcements');
            const res = await GET(req);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual([{ id: '1', title: 'Test' }]);

            mocks.getLatest.mockResolvedValue({ id: '2', title: 'Latest' });
            const reqLatest = new Request('http://localhost/api/announcements?latest=true');
            const resLatest = await GET(reqLatest);
            expect(resLatest.status).toBe(200);
            expect(await resLatest.json()).toEqual({ id: '2', title: 'Latest' });
        });
    });

    describe('POST', () => {
        it('returns 401 when non-admin attempts to create announcement', async () => {
            mocks.isUserAdmin.mockResolvedValue(false);

            const req = new Request('http://localhost/api/announcements', {
                method: 'POST',
                body: JSON.stringify({ title: 'T', content: 'C' })
            });
            const res = await POST(req);
            expect(res.status).toBe(401);
        });

        it('validates title and content and records author ID', async () => {
            mocks.isUserAdmin.mockResolvedValue(true);
            mocks.getCurrentUser.mockResolvedValue({ id: 'admin-user-1' });

            // Missing title
            const reqBad = new Request('http://localhost/api/announcements', {
                method: 'POST',
                body: JSON.stringify({ content: 'Only content' })
            });
            const resBad = await POST(reqBad);
            expect(resBad.status).toBe(400);

            // Valid payload
            mocks.create.mockResolvedValue({ id: 'ann-1', title: 'Title', content: 'Content', author_id: 'admin-user-1' });
            mocks.sendDiscordAnnouncement.mockResolvedValue(null);

            const reqOk = new Request('http://localhost/api/announcements', {
                method: 'POST',
                body: JSON.stringify({ title: 'Title', content: 'Content' })
            });
            const resOk = await POST(reqOk);
            expect(resOk.status).toBe(201);
            expect(mocks.create).toHaveBeenCalledWith('Title', 'Content', 'admin-user-1', undefined, undefined);
        });

        it('does not fail announcement creation if Discord send fails', async () => {
            mocks.isUserAdmin.mockResolvedValue(true);
            mocks.getCurrentUser.mockResolvedValue({ id: 'admin-user-1' });
            mocks.create.mockResolvedValue({ id: 'ann-1', title: 'Title', content: 'Content' });
            mocks.sendDiscordAnnouncement.mockRejectedValue(new Error('Discord Webhook Failed'));

            const req = new Request('http://localhost/api/announcements', {
                method: 'POST',
                body: JSON.stringify({ title: 'Title', content: 'Content' })
            });
            const res = await POST(req);
            expect(res.status).toBe(201);
            const data = await res.json();
            expect(data.id).toBe('ann-1');
        });
    });

    describe('PUT', () => {
        it('returns 401 for non-admin', async () => {
            mocks.isUserAdmin.mockResolvedValue(false);
            const req = new Request('http://localhost/api/announcements', {
                method: 'PUT',
                body: JSON.stringify({ id: 'ann-1', title: 'T', content: 'C' })
            });
            const res = await PUT(req);
            expect(res.status).toBe(401);
        });

        it('returns 404 for missing announcement', async () => {
            mocks.isUserAdmin.mockResolvedValue(true);
            mocks.getById.mockResolvedValue(null);
            mocks.update.mockResolvedValue(null);

            const req = new Request('http://localhost/api/announcements', {
                method: 'PUT',
                body: JSON.stringify({ id: 'nonexistent-id', title: 'T', content: 'C' })
            });
            const res = await PUT(req);
            expect(res.status).toBe(404);
        });

        it('swallows Discord update failures', async () => {
            mocks.isUserAdmin.mockResolvedValue(true);
            mocks.getById.mockResolvedValue({ id: 'ann-1', discord_message_id: 'disc-1' });
            mocks.updateDiscordAnnouncement.mockRejectedValue(new Error('Discord API Error'));
            mocks.update.mockResolvedValue({ id: 'ann-1', title: 'Updated Title', content: 'C' });

            const req = new Request('http://localhost/api/announcements', {
                method: 'PUT',
                body: JSON.stringify({ id: 'ann-1', title: 'Updated Title', content: 'C' })
            });
            const res = await PUT(req);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ id: 'ann-1', title: 'Updated Title', content: 'C' });
        });
    });

    describe('DELETE', () => {
        it('returns 401 for non-admin', async () => {
            mocks.isUserAdmin.mockResolvedValue(false);
            const req = new Request('http://localhost/api/announcements?id=1', { method: 'DELETE' });
            const res = await DELETE(req);
            expect(res.status).toBe(401);
        });

        it('returns 400 when id query parameter is missing', async () => {
            mocks.isUserAdmin.mockResolvedValue(true);
            const req = new Request('http://localhost/api/announcements', { method: 'DELETE' });
            const res = await DELETE(req);
            expect(res.status).toBe(400);
        });

        it('swallows Discord delete failures', async () => {
            mocks.isUserAdmin.mockResolvedValue(true);
            mocks.getById.mockResolvedValue({ id: 'ann-1', discord_message_id: 'disc-1' });
            mocks.deleteDiscordAnnouncement.mockRejectedValue(new Error('Discord API Error'));
            mocks.delete.mockResolvedValue(undefined);

            const req = new Request('http://localhost/api/announcements?id=ann-1', { method: 'DELETE' });
            const res = await DELETE(req);
            expect(res.status).toBe(200);
            expect(mocks.delete).toHaveBeenCalledWith('ann-1');
        });
    });
});
