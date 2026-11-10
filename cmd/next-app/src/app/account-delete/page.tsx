import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AccountDeleteForm } from '@/components/account/AccountDeleteForm';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { getAccountDeletionSites } from '@/lib/account-deletion-service';
import { getCurrentUser } from '@/lib/auth-checks';
import { accountFingerprint, logEvent, observePage } from '@/lib/observability';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Delete Account | Powerwall Usage',
    robots: { index: false, follow: false },
};

export default observePage('/account-delete', async function AccountDeletePage() {
    const user = await getCurrentUser();
    if (!user) redirect('/login?callback=/account-delete');

    const sites = await getAccountDeletionSites(user.id);
    const soleSites = sites.filter(site => !site.shared);
    const sharedSites = sites.filter(site => site.shared);
    const batterySaverSites = sites.filter(site => site.batterySaverRestoreReserve !== null);
    logEvent('info', 'user.account-deletion.page-viewed', {
        accountId: accountFingerprint(user.id),
        siteCount: sites.length,
        sitesDeleted: soleSites.length,
        sitesRetained: sharedSites.length,
        batterySaverActive: batterySaverSites.length > 0,
    });

    return (
        <PageShell maxWidth="lg">
            <PageHeader
                title="Delete Account"
                description="Permanently delete your pwusage account. This cannot be undone."
                className="mb-6"
            />
            <div className="space-y-6">
                {batterySaverSites.map(site => (
                    <Alert key={site.id} variant="warning">
                        <AlertTitle>Battery Saver is on for {site.name}</AlertTitle>
                        <AlertDescription>
                            Battery Saver is holding your Powerwall charge. Deleting your account turns it off and
                            restores your backup reserve to {site.batterySaverRestoreReserve}%.
                        </AlertDescription>
                    </Alert>
                ))}
                <SectionCard title="What gets deleted" bodyClassName="space-y-4 text-sm">
                    {sites.length === 0 && (
                        <p>Your pwusage account and the Tesla sign-in details stored with it. No sites are linked to this account.</p>
                    )}
                    {soleSites.length > 0 && (
                        <>
                            <p>Your pwusage account and these sites, with their history, rate plans, Battery Saver settings and TRMNL connections:</p>
                            <ul className="list-disc space-y-1 pl-5">
                                {soleSites.map(site => <li key={site.id}>{site.name}</li>)}
                            </ul>
                        </>
                    )}
                    {sharedSites.length > 0 && (
                        <>
                            <p>Your membership on these shared sites and any TRMNL display you connected. These sites and their history stay available to the other members:</p>
                            <ul className="list-disc space-y-1 pl-5">
                                {sharedSites.map(site => <li key={site.id}>{site.name}</li>)}
                            </ul>
                        </>
                    )}
                </SectionCard>
                <SectionCard title="What deleting does not change" bodyClassName="space-y-4 text-sm">
                    <p>Your Powerwall and your Tesla account keep working as they do now.</p>
                    <p>Backups can keep deleted data for up to about 8 weeks, until they expire. Service logs can keep technical details until they expire.</p>
                    <p>If you use the iPhone app, its saved data clears the next time it opens. Any solar layout saved to your private iCloud stays there until you remove it in your iPhone&apos;s iCloud settings.</p>
                    <p>If you use TRMNL, remove the pwusage plugin in TRMNL. It stops receiving data once your account is deleted.</p>
                    <p>Signing in with Tesla later creates a new, empty pwusage account.</p>
                </SectionCard>
                <SectionCard title="Confirm">
                    <AccountDeleteForm />
                </SectionCard>
            </div>
        </PageShell>
    );
});
