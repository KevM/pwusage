import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Image from 'next/image';
import { getDefaultSiteId, isUserAdmin } from '@/lib/auth-checks';
import { UserRepo } from '@/lib/user-repo';
import { SiteRepo } from '@/lib/site-repo';
import { createTeslaClientForUser } from '@/lib/tesla-client-factory';
import { PageBreadcrumbs } from '@/components/PageBreadcrumbs';
import { H3, P } from '@/components/ui/Typography';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageShell } from '@/components/ui/PageShell';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionCard } from '@/components/ui/SectionCard';

export const dynamic = 'force-dynamic';


export default async function ProfilePage() {
    const cookieStore = await cookies();
    const siteAuthToken = cookieStore.get('site_auth')?.value;

    if (!siteAuthToken) {
        redirect('/login');
    }

    const defaultSiteId = await getDefaultSiteId();
    if (!defaultSiteId) {
        // If user has no sites (even if admin), redirect to products or show empty
        redirect('/products');
    }

    const siteId = defaultSiteId;

    // Resolve User from the first site (assuming all sites belong to the same user in current context)
    // Or we find the user via token, but we don't store user_id in cookie directly yet.
    // We can lookup any site in DB to get user_id.
    const repo = new SiteRepo();
    const firstSite = await repo.getSite(siteId);

    if (!firstSite || !firstSite.user_id) {
        return (
            <PageShell maxWidth="lg">
                <Alert variant="danger">
                    <AlertTitle>Profile Unavailable</AlertTitle>
                    <AlertDescription>Could not resolve user profile.</AlertDescription>
                </Alert>
            </PageShell>
        );
    }

    const user = await new UserRepo().getById(firstSite.user_id);

    if (!user) {
        return (
            <PageShell maxWidth="lg">
                <Alert variant="danger">
                    <AlertTitle>Profile Unavailable</AlertTitle>
                    <AlertDescription>User detailed record not found.</AlertDescription>
                </Alert>
            </PageShell>
        );
    }

    // Check Admin Status
    const isAdmin = await isUserAdmin();

    // Fetch info from Tesla
    let teslaUser = null;
    let error = null;
    try {
        const client = await createTeslaClientForUser(user.id);
        if (client) {
            teslaUser = await client.getUserInfo();
        }
    } catch (e) {
        console.error('Failed to fetch Tesla User Info', e);
        error = 'Failed to load valid profile data from Tesla.';
    }

    return (
        <PageShell maxWidth="lg">
            <PageBreadcrumbs items={[
                { label: firstSite.name, href: `/site/${firstSite.id}` },
                { label: 'Profile' }
            ]} />
            <PageHeader title="User Profile" titleTag="h2" density="compact" className="mb-6 mt-4" />

            <SectionCard
                title="Account Details"
                description={
                    <>
                        Review your Tesla account profile and linked application identity.
                    </>
                }
            >
                <div className="space-y-6">

                {teslaUser && (
                    <div className="flex items-center gap-6">
                        {teslaUser.profile_image_url ? (
                            <Image
                                src={teslaUser.profile_image_url}
                                alt="Profile"
                                width={96}
                                height={96}
                                className="rounded-full object-cover border"
                            />
                        ) : (
                            <div className="w-24 h-24 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-4xl">
                                <span>{teslaUser.full_name?.[0] || user.email?.substring(0, 2) || '?'}</span>
                            </div>
                        )}
                        <div>
                            <H3>{teslaUser.full_name}</H3>
                            <P className="text-sm text-gray-500 dark:text-gray-400">{teslaUser.email}</P>
                        </div>
                    </div>
                )}

                {!teslaUser && error && (
                    <Alert variant="danger">
                        <AlertTitle>Tesla Profile Error</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                <div className="border-t pt-4 space-y-4">
                    <div>
                        <h4 className="text-sm font-medium text-muted-foreground">Member Since</h4>
                        <P className="text-sm leading-normal">
                            {user.created_at ? new Date(Number(user.created_at)).toLocaleDateString(undefined, {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric'
                            }) : <span className="italic text-muted-foreground">Unknown</span>}
                        </P>
                    </div>

                    <div>
                        <h4 className="text-sm font-medium text-muted-foreground">User ID</h4>
                        <P className="text-sm font-mono bg-slate-100 dark:bg-slate-800 p-1 rounded inline-block select-all">
                            {user.id}
                        </P>
                    </div>
                </div>

                {isAdmin && (
                    <div className="border-t pt-4">
                        <h4 className="text-sm font-medium text-muted-foreground mb-3">Administration</h4>
                        <Link href="/admin">
                            <Button renderAs="span">Access Admin Dashboard</Button>
                        </Link>
                    </div>
                )}

                </div>
            </SectionCard>
        </PageShell>
    );
}
