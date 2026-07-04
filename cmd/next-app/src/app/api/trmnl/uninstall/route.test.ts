import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getInstallationByUuid: vi.fn(),
    deleteInstallation: vi.fn(),
    verifyTrmnlRequestAuth: vi.fn(),
}));

vi.mock('@/lib/trmnl-service', () => ({
    TrmnlService: class {
        getInstallationByUuid = mocks.getInstallationByUuid;
        deleteInstallation = mocks.deleteInstallation;
    }
}));

vi.mock('@/lib/trmnl-auth', () => ({
    verifyTrmnlRequestAuth: mocks.verifyTrmnlRequestAuth,
}));

import { POST } from './route';

describe('POST /api/trmnl/uninstall', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 400 when user_uuid is missing in body', async () => {
        const req = new Request('http://localhost/api/trmnl/uninstall', {
            method: 'POST',
            body: JSON.stringify({})
        });
        const res = await POST(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Missing user_uuid');
    });

    it('returns 200 idempotent success when installation is unknown / not found', async () => {
        mocks.getInstallationByUuid.mockResolvedValue(null);

        const req = new Request('http://localhost/api/trmnl/uninstall', {
            method: 'POST',
            body: JSON.stringify({ user_uuid: 'uuid-123' })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(mocks.deleteInstallation).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization Bearer token is missing', async () => {
        mocks.getInstallationByUuid.mockResolvedValue({ uuid: 'uuid-123' });

        const req = new Request('http://localhost/api/trmnl/uninstall', {
            method: 'POST',
            body: JSON.stringify({ user_uuid: 'uuid-123' })
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toContain('Missing Bearer token');
    });

    it('authorizes deletion with valid token', async () => {
        const mockInstallation = { uuid: 'uuid-123', access_token: 'secret-token' };
        mocks.getInstallationByUuid.mockResolvedValue(mockInstallation);
        mocks.verifyTrmnlRequestAuth.mockResolvedValue(true);

        const req = new Request('http://localhost/api/trmnl/uninstall', {
            method: 'POST',
            headers: { Authorization: 'Bearer valid-token' },
            body: JSON.stringify({ user_uuid: 'uuid-123' })
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mocks.verifyTrmnlRequestAuth).toHaveBeenCalledWith('valid-token', 'uuid-123', mockInstallation);
        expect(mocks.deleteInstallation).toHaveBeenCalledWith('uuid-123');
    });

    it('returns 401 and does not delete when token verification fails', async () => {
        const mockInstallation = { uuid: 'uuid-123', access_token: 'secret-token' };
        mocks.getInstallationByUuid.mockResolvedValue(mockInstallation);
        mocks.verifyTrmnlRequestAuth.mockResolvedValue(false);

        const req = new Request('http://localhost/api/trmnl/uninstall', {
            method: 'POST',
            headers: { Authorization: 'Bearer wrong-token' },
            body: JSON.stringify({ user_uuid: 'uuid-123' })
        });
        const res = await POST(req);
        expect(res.status).toBe(401);
        expect(mocks.deleteInstallation).not.toHaveBeenCalled();
    });
});
