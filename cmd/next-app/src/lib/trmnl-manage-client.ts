export interface ManageInitialLoadResult {
    redirecting: boolean;
    token: string | null;
    sites: { id: string; name: string; utility: string }[];
    installData: {
        site_id?: string | null;
        plugin_setting_id?: number | null;
        component_screens?: unknown;
    } | null;
}

/**
 * Removes reusable TRMNL credentials and one-time handoff IDs from the visible browser URL.
 */
export function stripManageCredentialsFromUrl(
    currentHref: string,
    replaceState: (nextUrl: string) => void
): boolean {
    const currentUrl = new URL(currentHref);
    if (
        !currentUrl.searchParams.has('token')
        && !currentUrl.searchParams.has('jwt')
        && !currentUrl.searchParams.has('handoff')
    ) {
        return false;
    }
    currentUrl.searchParams.delete('token');
    currentUrl.searchParams.delete('jwt');
    currentUrl.searchParams.delete('handoff');
    const nextSearch = currentUrl.searchParams.toString();
    replaceState(`${currentUrl.pathname}${nextSearch ? `?${nextSearch}` : ''}${currentUrl.hash}`);
    return true;
}

export function buildManageLoginRedirectUrl(params: {
    uuid: string;
    pluginSettingId?: string | null;
    handoffId?: string | null;
}): string {
    const callbackParams = new URLSearchParams({ uuid: params.uuid });
    if (params.pluginSettingId) {
        callbackParams.set('plugin_setting_id', params.pluginSettingId);
    }
    if (params.handoffId) {
        callbackParams.set('handoff', params.handoffId);
    }
    const callbackUrl = encodeURIComponent(`/trmnl/manage?${callbackParams.toString()}`);
    return `/login?callback=${callbackUrl}`;
}

export async function loadManageInitialData(params: {
    uuid: string;
    initialToken: string | null;
    handoffId: string | null;
    pluginSettingId?: string | null;
    fetchImpl: typeof fetch;
    onRedirect: (loginUrl: string) => void;
    isCancelled?: () => boolean;
}): Promise<ManageInitialLoadResult> {
    let activeToken = params.initialToken;

    if (params.handoffId && !activeToken) {
        const consumeRes = await params.fetchImpl('/api/trmnl/manage/handoff/consume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ handoffId: params.handoffId, uuid: params.uuid }),
        });
        if (params.isCancelled?.()) {
            return { redirecting: false, token: null, sites: [], installData: null };
        }
        if (consumeRes.ok) {
            const consumed = await consumeRes.json() as { token?: string };
            if (typeof consumed.token === 'string' && consumed.token) {
                activeToken = consumed.token;
            }
        }
    }

    const manageHeaders: HeadersInit | undefined = activeToken
        ? { Authorization: `Bearer ${activeToken}` }
        : undefined;

    const [sitesRes, installRes] = await Promise.all([
        params.fetchImpl('/api/sites', { credentials: 'include' }),
        params.fetchImpl(`/api/trmnl/manage?uuid=${encodeURIComponent(params.uuid)}`, {
            credentials: 'include',
            headers: manageHeaders,
        }),
    ]);
    if (params.isCancelled?.()) {
        return { redirecting: false, token: activeToken, sites: [], installData: null };
    }

    if (installRes.status === 401 || sitesRes.status === 401) {
        let handoffId: string | null = null;
        if (activeToken) {
            const handoffRes = await params.fetchImpl('/api/trmnl/manage/handoff', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ uuid: params.uuid, token: activeToken }),
            });
            if (params.isCancelled?.()) {
                return { redirecting: false, token: activeToken, sites: [], installData: null };
            }
            if (handoffRes.ok) {
                const handoffData = await handoffRes.json() as { handoffId?: string };
                if (typeof handoffData.handoffId === 'string' && handoffData.handoffId) {
                    handoffId = handoffData.handoffId;
                }
            }
        }

        if (!params.isCancelled?.()) {
            params.onRedirect(buildManageLoginRedirectUrl({
                uuid: params.uuid,
                pluginSettingId: params.pluginSettingId,
                handoffId,
            }));
        }
        return { redirecting: true, token: activeToken, sites: [], installData: null };
    }

    const sites = sitesRes.ok
        ? (await sitesRes.json()) as { id: string; name: string; utility: string }[]
        : [];
    const installData = installRes.ok
        ? (await installRes.json()) as ManageInitialLoadResult['installData']
        : null;

    return { redirecting: false, token: activeToken, sites, installData };
}
