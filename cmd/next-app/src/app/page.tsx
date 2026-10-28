import { observePage } from '@/lib/observability';
import { cookies } from 'next/headers';
import Link from 'next/link';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { getAuthorizedSiteIds, hasValidSession } from '@/lib/auth-checks';
import { SiteRepo } from '@/lib/site-repo';
import { ProductWithLiveData } from '@/components/DashboardCards';
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

  const announcementRepo = new AnnouncementRepo();
  const latestAnnouncement = await announcementRepo.getLatest();

  // If no token at all, show login screen
  if (!siteAuthToken) {
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
            </SectionCard>

            <div className="flex justify-center">
              <LoginAnnouncement announcement={latestAnnouncement} />
            </div>
          </div>
        </PageShell>
      </div>
    );
  }

  let products: ProductWithLiveData[] = []; // We will map this to ProductWithLiveData
  const repo = new SiteRepo();

  // DB-backed: revoked sessions go to login; site membership comes from the DB,
  // not the JWT claims.
  if (!await hasValidSession()) {
    redirect('/login');
  }

  const siteIds = await getAuthorizedSiteIds();
  if (siteIds.length === 0) {
    // Car-only users are authenticated and should land on the products page.
    redirect('/products');
  }

  const sitePromises = siteIds.map(id => repo.getSite(id));
  const sitesResults = await Promise.all(sitePromises);
  const validSites = sitesResults.filter((s): s is NonNullable<typeof s> => !!s);

  products = validSites.map(s => ({
    id: s.id,
    site_name: s.name,
    energy_site_id: s.id,
    percentage_charged: 0,
    currentTariff: 'Loading...',
    liveBatteryPower: 0,
    liveSolarPower: 0,
    liveLoadPower: 0,
    liveGridPower: 0
  }));

  if (products.length === 1) {
    redirect(`/site/${products[0].id}`);
  } else if (products.length > 1) {
    redirect('/products');
  } else {
    // 0 energy sites.
    // Redirect to products page (it will try to show vehicles or "No Products")
    redirect('/products');
  }

  // This code below is unreachable now due to redirects, but kept for type safety if logic changes
  return null;
});
