import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Image from 'next/image';
import { getDefaultSiteId, isUserAdmin } from '@/lib/auth-checks';
import { EnergyRepo } from '@/lib/energy-repo';
import { TeslaClient } from '@/lib/tesla-client';
import { pool, User } from '@/lib/db';
import { Breadcrumbs } from '@/components/Breadcrumbs';

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
    const repo = new EnergyRepo();
    const firstSite = await repo.getSite(siteId);

    if (!firstSite || !firstSite.user_id) {
        return <div className="p-8">Could not resolve user profile.</div>;
    }

    const userRes = await pool.query('SELECT * FROM "User" WHERE id = $1', [firstSite.user_id]);
    const user = userRes.rows[0] as User;

    if (!user) {
        return <div className="p-8">User detailed record not found.</div>;
    }

    // Check Admin Status
    const isAdmin = await isUserAdmin();

    // Fetch info from Tesla
    let teslaUser = null;
    let error = null;
    if (user.access_token) {
        try {
            const client = new TeslaClient({ accessToken: user.access_token, refreshToken: user.refresh_token || undefined });
            teslaUser = await client.getUserInfo();
        } catch (e) {
            console.error('Failed to fetch Tesla User Info', e);
            error = 'Failed to load valid profile data from Tesla.';
        }
    }

    return (
        <div className="container mx-auto p-6 max-w-2xl">
            <Breadcrumbs items={[
                { label: firstSite.name, href: `/site/${firstSite.id}` },
                { label: 'Profile' }
            ]} />
            <h1 className="text-3xl font-bold tracking-tight mb-8">User Profile</h1>

            <div className="rounded-xl border bg-card text-card-foreground shadow-sm p-6 space-y-6">

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
                            <h2 className="text-2xl font-semibold">{teslaUser.full_name}</h2>
                            <p className="text-muted-foreground">{teslaUser.email}</p>
                        </div>
                    </div>
                )}

                {!teslaUser && error && (
                    <div className="p-4 bg-red-50 text-red-600 rounded-md">
                        {error}
                    </div>
                )}

                <div className="border-t pt-4">
                    <div>
                        <h3 className="text-sm font-medium text-muted-foreground">Member Since</h3>
                        <p className="text-sm">
                            {user.created_at ? new Date(Number(user.created_at)).toLocaleDateString(undefined, {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric'
                            }) : <span className="italic text-muted-foreground">Unknown</span>}
                        </p>
                    </div>
                </div>

                {isAdmin && (
                    <div className="border-t pt-4">
                        <h3 className="text-sm font-medium text-muted-foreground mb-3">Administration</h3>
                        <Link
                            href="/admin"
                            className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2 bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                        >
                            Access Admin Dashboard
                        </Link>
                    </div>
                )}

            </div>
        </div>
    );
}
