import { cookies } from 'next/headers';
import Link from 'next/link';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { verifySiteToken } from '@/lib/auth-jwt';
import { EnergyRepo } from '@/lib/energy-repo';
import { ProductWithLiveData } from '@/components/DashboardCards';
import { AnnouncementRepo } from '@/lib/announcement-repo';
import { LoginAnnouncement } from '@/components/LoginAnnouncement';

// Force dynamic rendering to always fetch fresh data
export const dynamic = 'force-dynamic';

export default async function Home() {
  const cookieStore = await cookies();
  const siteAuthToken = cookieStore.get('site_auth')?.value;

  const announcementRepo = new AnnouncementRepo();
  const latestAnnouncement = await announcementRepo.getLatest();

  // If no token at all, show login screen
  if (!siteAuthToken) {
    return (
      // ... (inside the if (!siteAuthToken) block)
      <div className="flex min-h-screen flex-col items-center justify-center p-6 md:p-24">
        <h1 className="text-4xl font-bold mb-8">Powerwall Usage</h1>
        <Image
          src="/login-summary-v2.png"
          alt="Monitor Usage, Track Costs, Maximize Savings"
          width={930}
          height={375}
          className="mb-8 block dark:hidden"
          priority
        />
        <Image
          src="/login-summary-dark-v2.png"
          alt="Monitor Usage, Track Costs, Maximize Savings"
          width={930}
          height={375}
          className="mb-8 hidden dark:block"
          priority
        />
        <Link
          href="/login"
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        >
          Login with Tesla
        </Link>
        <Link
          href="/about"
          className="mt-4 text-blue-600 hover:text-blue-800 underline"
        >
          Learn More
        </Link>

        {/* Latest Announcement */}
        <LoginAnnouncement announcement={latestAnnouncement} />
      </div>
    );
  }

  let products: ProductWithLiveData[] = []; // We will map this to ProductWithLiveData
  const repo = new EnergyRepo();

  const decoded = verifySiteToken(siteAuthToken);
  if (!decoded) {
    redirect('/login');
  }

  if (decoded.sites.length === 0) {
    // Car-only users are authenticated and should land on the products page.
    redirect('/products');
  }

  const sitePromises = decoded.sites.map(id => repo.getSite(id));
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
}
