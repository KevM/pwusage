import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { GlobalHeader } from "@/components/GlobalHeader";

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
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <GlobalHeader />
        <main className="min-h-screen">
          {children}
        </main>
      </body>
    </html>
  );
}
