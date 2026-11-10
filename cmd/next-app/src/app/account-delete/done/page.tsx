import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { getAppBaseUrl } from '@/lib/url-utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Account Deleted | Powerwall Usage',
    robots: { index: false, follow: false },
};

function teslaRevokeUrl(): string | null {
    const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID?.trim();
    if (!clientId) return null;
    const params = new URLSearchParams({
        revoke_client_id: clientId,
        back_url: `${getAppBaseUrl()}/account-delete/done`,
    });
    return `https://auth.tesla.com/user/revoke/consent?${params}`;
}

// Public on purpose: the session is gone by the time this renders, so it cannot tell
// whether a deletion really happened. It stays general and shows no account details.
export default function AccountDeleteDonePage() {
    const revokeUrl = teslaRevokeUrl();
    return (
        <PageShell maxWidth="lg">
            <PageHeader
                title="Account Deleted"
                description="Your pwusage account has been deleted."
                className="mb-6"
            />
            <div className="space-y-6">
                <SectionCard title="Optional: remove pwusage from your Tesla account" bodyClassName="space-y-4 text-sm">
                    <p>pwusage no longer has your Tesla sign-in details, but your Tesla account may still list pwusage as an app you approved. You can remove it at any time.</p>
                    {revokeUrl ? (
                        <a href={revokeUrl}>
                            <Button renderAs="span" variant="outline">Remove pwusage from Tesla</Button>
                        </a>
                    ) : (
                        <p>You can do this in your Tesla account&apos;s third-party app settings.</p>
                    )}
                </SectionCard>
                <SectionCard title="What happens next" bodyClassName="space-y-4 text-sm">
                    <p>Backups can keep deleted data for up to about 8 weeks, until they expire.</p>
                    <p>If you use the iPhone app, its saved data clears the next time it opens. Any solar layout saved to your private iCloud stays there until you remove it in your iPhone&apos;s iCloud settings.</p>
                    <p>If you use TRMNL, remove the pwusage plugin in TRMNL.</p>
                    <p>
                        Questions? Visit the <Link href="/support" className="text-primary underline">support page</Link>.
                    </p>
                </SectionCard>
            </div>
        </PageShell>
    );
}
