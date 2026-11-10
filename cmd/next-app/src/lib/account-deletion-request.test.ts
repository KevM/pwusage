import { describe, expect, it, vi } from 'vitest';
import { requestAccountDeletion } from './account-deletion-request';

const respond = (status: number, body: string) => vi.fn().mockResolvedValue(new Response(body, { status }));

describe('requestAccountDeletion', () => {
    it('sends the typed confirmation', async () => {
        const fetcher = respond(200, '{"ok":true}');
        await expect(requestAccountDeletion(fetcher)).resolves.toEqual({ ok: true });
        expect(fetcher).toHaveBeenCalledWith('/api/user', expect.objectContaining({
            method: 'DELETE',
            body: JSON.stringify({ confirm: 'DELETE' }),
        }));
    });

    it('shows the message from the server', async () => {
        const fetcher = respond(409, '{"error":"Reconnect Tesla."}');
        await expect(requestAccountDeletion(fetcher)).resolves.toEqual({ ok: false, message: 'Reconnect Tesla.' });
    });

    it('falls back when the error body is not JSON', async () => {
        const result = await requestAccountDeletion(respond(502, 'Bad gateway'));
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Check your connection') });
    });

    it('falls back when the network fails', async () => {
        const result = await requestAccountDeletion(vi.fn().mockRejectedValue(new Error('offline')));
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Check your connection') });
    });
});
