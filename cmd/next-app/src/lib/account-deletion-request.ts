export const ACCOUNT_DELETE_CONFIRMATION = 'DELETE';

export type AccountDeletionRequestResult = { ok: true } | { ok: false; message: string };

const FALLBACK_MESSAGE = 'Could not delete your account. Check your connection and try again.';

export async function requestAccountDeletion(
    deleteSiteIds: string[] = [],
    fetcher: typeof fetch = fetch,
): Promise<AccountDeletionRequestResult> {
    try {
        const response = await fetcher('/api/user', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: ACCOUNT_DELETE_CONFIRMATION, deleteSiteIds }),
        });
        if (response.ok) return { ok: true };
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        return { ok: false, message: typeof body?.error === 'string' ? body.error : FALLBACK_MESSAGE };
    } catch {
        return { ok: false, message: FALLBACK_MESSAGE };
    }
}
