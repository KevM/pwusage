import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

import { GlobalHeader } from "@/components/GlobalHeader";
import { Footer } from "@/components/Footer";

const isPreviewDeployment = process.env.VERCEL_ENV === "preview";
const appTitle = isPreviewDeployment ? "Powerwall Usage (Preview)" : "Powerwall Usage";

const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: appTitle,
  description: "Powerwall insights for smarter energy savings.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL
      ? process.env.NEXT_PUBLIC_APP_URL
      : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  ),
  openGraph: {
    title: appTitle,
    description: "Powerwall insights for smarter energy savings.",
    siteName: "Powerwall Usage",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    description: "Powerwall insights for smarter energy savings.",
  },
  alternates: {
    types: {
      'application/rss+xml': '/feed.xml',
    },
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const showStyleGuide = process.env.NODE_ENV === "development";
  /* Sites fetching logic removed as it was only used for GlobalHeader which no longer needs it. 
     Keeping auth check logic if needed for other reasons, but seemingly the sites variable itself is now unused.
     actually, let's keep it simple and just remove the sites variable and its populating logic. 
     Wait, do we need to keep the auth token retrieval? 
     The original code retrieved tokens to fetch sites.
     If we don't fetch sites, we might not need to reference the Repo or tokens here at all?
     
     Let's check lines 30-58.
     It instantiates EnergyRepo and fetches sites.
     If I remove all of that, `RootLayout` becomes very simple.
  */

  // We can remove the entire block of site fetching.
  // But wait, does verifying the token serve a security purpose here?
  // No, this is just layout. Layout doesn't protect routes (usually middleware or page logic does).

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased flex flex-col min-h-screen`}
      >
        <GlobalHeader showStyleGuide={showStyleGuide} />
        <main className="flex-grow min-h-screen">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
