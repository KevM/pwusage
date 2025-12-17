import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";

import { GlobalHeader } from "@/components/GlobalHeader";
import { EnergyRepo } from "@/lib/energy-repo";
import { verifySiteToken } from "@/lib/auth-jwt";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Powerwall Usage",
  description: "Tesla Powerwall Usage Monitor",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const siteAuthToken = cookieStore.get('site_auth')?.value;
  // Check for legacy access token to support users not yet migrated to site_auth
  const accessToken = cookieStore.get('access_token')?.value;
  let sites: { id: string; name: string }[] = [];

  const repo = new EnergyRepo();

  if (siteAuthToken) {
    const siteIds = verifySiteToken(siteAuthToken);
    console.log('[RootLayout] siteAuthToken present, ids:', siteIds);
    if (siteIds && siteIds.length > 0) {
      const sitePromises = siteIds.map(id => repo.getSite(id));
      const sitesResults = await Promise.all(sitePromises);

      sites = sitesResults
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map(s => ({ id: s.id, name: s.name }));
      console.log('[RootLayout] Fetched sites (via site_auth):', sites);
    }
  } else if (accessToken) {
    console.log('[RootLayout] AccessToken present, fetching all sites...');
    // Fallback: fetch all sites if user has legacy access_token
    const allSites = await repo.getSites();
    sites = allSites.map(s => ({ id: s.id, name: s.name }));
    console.log('[RootLayout] Fetched sites (via fallback):', sites);
  } else {
    console.log('[RootLayout] No valid tokens found');
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <GlobalHeader sites={sites} />
        <main className="min-h-screen">
          {children}
        </main>
      </body>
    </html>
  );
}
