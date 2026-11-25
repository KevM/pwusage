import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { PageHeader } from '@/components/ui/PageHeader';
import { P } from '@/components/ui/Typography';
import { resolveOAuthClient } from '@/lib/oauth/client-resolver';
import { validateRedirectUri } from '@/lib/oauth/validation';

async function resolveOAuthCancelUrl(callback: string | undefined): Promise<{
    retryHref: string;
    cancelHref: string | null;
} | null> {
    if (!callback || !callback.startsWith('/oauth/authorize?')) {
        return null;
    }

    const retryHref = `/login?switch_account=1&callback=${encodeURIComponent(callback)}`;
    try {
        const parsed = new URL(callback, 'https://pwusage.invalid');
        const clientId = parsed.searchParams.get('client_id')?.trim() ?? '';
        const rawRedirectUri = parsed.searchParams.get('redirect_uri')?.trim() ?? '';
        const state = parsed.searchParams.get('state');

        if (!clientId || !rawRedirectUri) {
            return { retryHref, cancelHref: null };
        }
        const checkedUri = validateRedirectUri(rawRedirectUri);
        if (!checkedUri.ok) {
            return { retryHref, cancelHref: null };
        }
        const client = await resolveOAuthClient(clientId);
        if (!client || !client.redirectUris.includes(checkedUri.uri)) {
            return { retryHref, cancelHref: null };
        }
        const cancelTarget = new URL(checkedUri.uri);
        cancelTarget.searchParams.set('error', 'access_denied');
        if (state) cancelTarget.searchParams.set('state', state);
        return { retryHref, cancelHref: cancelTarget.href };
    } catch {
        return { retryHref, cancelHref: null };
    }
}

export default async function NoSitesPage({
    searchParams,
}: {
    searchParams: Promise<{ reason?: string; callback?: string }>;
}) {
    const { reason, callback } = await searchParams;
    const oauthActions = await resolveOAuthCancelUrl(callback);

    // A brand-new Tesla account with no energy products is never stored, so it
    // has no session; say so plainly instead of "no longer has access".
    if (reason === 'no-products') {
        return (
            <PageShell maxWidth="lg">
                <PageHeader title="No Powerwall yet" titleTag="h1" />
                <P>Tesla sign-in succeeded, but this account has no Powerwall or other Tesla Energy site yet. We have not saved anything about this account.</P>
                <P>When you add a Powerwall, sign in again and your energy site will appear automatically.</P>
                {oauthActions ? (
                    <div className="flex flex-wrap items-center gap-4 pt-2">
                        <Link href={oauthActions.retryHref} className="underline">Try a different Tesla account</Link>
                        {oauthActions.cancelHref && (
                            <a href={oauthActions.cancelHref} className="text-sm text-muted-foreground underline">
                                Cancel and return to app
                            </a>
                        )}
                    </div>
                ) : (
                    <Link href="/login" className="underline">Sign in with another Tesla account</Link>
                )}
            </PageShell>
        );
    }
    return (
        <PageShell maxWidth="lg">
            <PageHeader title="No Powerwall access" titleTag="h1" />
            <P>Tesla sign-in succeeded, but this account no longer has access to a Powerwall site.</P>
            <P>If someone removed your access in Tesla, ask them to add you again. Then sign in to pwusage.</P>
            {oauthActions ? (
                <div className="flex flex-wrap items-center gap-4 pt-2">
                    <Link href={oauthActions.retryHref} className="underline">Try a different Tesla account</Link>
                    {oauthActions.cancelHref && (
                        <a href={oauthActions.cancelHref} className="text-sm text-muted-foreground underline">
                            Cancel and return to app
                        </a>
                    )}
                </div>
            ) : (
                <Link href="/login" className="underline">Sign in with another Tesla account</Link>
            )}
            <P className="text-sm text-muted-foreground">
                Not planning to use pwusage? <Link href="/login?callback=/account-delete" prefetch={false} className="text-primary underline">Delete your account</Link>.
            </P>
        </PageShell>
    );
}
