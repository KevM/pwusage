import { observePage } from '@/lib/observability';
import { cookies } from 'next/headers';
import Link from 'next/link';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { getAuthorizedSites, hasValidSession } from '@/lib/auth-checks';
import { AnnouncementRepo } from '@/lib/announcement-repo';
import { LoginAnnouncement } from '@/components/LoginAnnouncement';
import { Button } from '@/components/ui/Button';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';

// Force dynamic rendering to always fetch fresh data
export const dynamic = 'force-dynamic';

export default observePage('/', async function Home() {
  const cookieStore = await cookies();
  const siteAuthToken = cookieStore.get('site_auth')?.value;

  // If no token at all, show login screen
  if (!siteAuthToken) {
    // Only the login screen shows the announcement.
    const latestAnnouncement = await new AnnouncementRepo().getLatest();
    return (
      <div className="bg-bg-muted/30">
        <PageShell
          maxWidth="4xl"
          padding="relaxed"
          className="flex items-center justify-center"
        >
          <div className="w-full space-y-6">
            <SectionCard bodyClassName="flex flex-col items-center gap-6 text-center">
              <h1 className="text-3xl font-bold tracking-tight text-primary sm:text-4xl">
                Powerwall Usage
              </h1>
              <Image
                src="/login-summary-v2.png"
                alt="Monitor Usage, Track Costs, Maximize Savings"
                width={930}
                height={375}
                className="block w-full rounded-md border dark:hidden"
                priority
              />
              <Image
                src="/login-summary-dark-v2.png"
                alt="Monitor Usage, Track Costs, Maximize Savings"
                width={930}
                height={375}
                className="hidden w-full rounded-md border dark:block"
                priority
              />
              <div className="flex flex-col items-center gap-3 sm:flex-row">
                <a href="/login">
                  <Button renderAs="span" size="lg">
                    Login with Tesla
                  </Button>
                </a>
                <Link href="/about">
                  <Button renderAs="span" size="lg" variant="outline">
                    Learn More
                  </Button>
                </Link>
              </div>
              <Link href="/ios" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
                New: the pwusage iPhone app is in beta. Join on TestFlight →
              </Link>
            </SectionCard>

            <div className="flex justify-center">
              <LoginAnnouncement announcement={latestAnnouncement} />
            </div>
          </div>
        </PageShell>
      </div>
    );
  }

  // DB-backed: revoked sessions go to login; site membership comes from the DB,
  // not the JWT claims.
  if (!await hasValidSession()) {
    redirect('/login');
  }

  // id + name is all the redirect needs; legacy tokens' stale IDs are dropped.
  // One site opens its dashboard; none (car-only) or several go to Products.
  const sites = await getAuthorizedSites();
  redirect(sites.length === 1 ? `/site/${sites[0].id}` : '/products');
});
