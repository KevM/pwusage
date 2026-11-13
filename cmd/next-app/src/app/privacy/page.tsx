import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';

export const metadata: Metadata = {
    title: 'Privacy Policy | Powerwall Usage',
    description: 'How pwusage handles Tesla account information, energy data, and data stored by the iOS app.',
    alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
    return (
        <PageShell maxWidth="lg" padding="default" fullHeight={false}>
            <PageHeader title="Privacy Policy" description="For the pwusage website and iOS app. Updated November 11, 2026." className="mb-8" />
            <div className="space-y-6 text-gray-700 dark:text-gray-300">
                <p>pwusage helps you understand your Powerwall energy use, estimate electricity costs, and use the optional Battery Saver feature for your Powerwall. This policy explains what information those features use.</p>
                <SectionCard title="Tesla account and energy information" bodyClassName="space-y-4">
                    <p>When you connect Tesla, Tesla handles your sign-in. pwusage receives account identifiers, your email address when provided by Tesla, and authorization tokens for the permissions you grant. We do not receive your Tesla password.</p>
                    <p>Our server stores connected energy-site information, including site names, identifiers, utility and time zone information, energy readings, battery status, rate plans, and settings. Tesla site responses may include location information. We use this data to show your dashboard, history, bill estimates, and Smart Shift recommendations.</p>
                    <p>The app downloads your solar production history from pwusage and uses it on your device to work out which way your solar panels face, how steeply they are tilted and how large they are.</p>
                    <p>If you use Battery Saver and grant the required command permission, pwusage stores Battery Saver settings and status and sends the backup reserve changes you request to Tesla. Scheduled checks use energy readings to monitor Battery Saver and restore your previous reserve.</p>
                </SectionCard>
                <SectionCard title="Information on your device" bodyClassName="space-y-4">
                    <p>The iOS app stores your session, selected site, preferences, Smart Shift jobs, and cached dashboard and forecast data on your device. Cached readings can remain visible offline and retain their original timestamps.</p>
                    <p>If you share your home location for solar features, the app rounds latitude and longitude to two decimals (about 1 km) and keeps the rounded location, with the detected panel layout, on your device and in your private iCloud so your other devices signed in to the same Apple ID can use it. pwusage does not receive your location or panel layout. The app sends rounded coordinates to Open-Meteo for forecasts and sends those coordinates, the site time zone, and the date range for historical weather. Your device estimates solar production and checks panel health locally. Your panel layout and production readings stay out of those requests.</p>
                    <p>Signing out clears the app&apos;s saved dashboard data and cached forecast state. Removing the app removes its local app data; iOS Keychain items may persist separately.</p>
                </SectionCard>
                <SectionCard title="How information is used and shared" bodyClassName="space-y-4">
                    <p>We use account and energy information to provide the features you request, keep your connection working, and investigate service problems. We do not sell your personal data or use it for advertising tracking.</p>
                    <p>The service runs on Vercel and uses a hosted PostgreSQL database on Supabase. Those providers process information needed to host and operate pwusage. Requests may produce operational logs containing technical details such as request paths, identifiers, IP addresses, and errors.</p>
                    <p>Tesla processes your sign-in and API requests under its own privacy policy. Open-Meteo processes forecast and historical weather requests from the app. Support services receive information you choose to submit.</p>
                </SectionCard>
                <SectionCard title="TRMNL integration" bodyClassName="space-y-4">
                    <p>If you install a TRMNL integration, pwusage shares the dashboard information needed to render your connected display. Our server stores your TRMNL OAuth access token, account and installation identifiers, display settings, and account information supplied by TRMNL, including your email address. We use these records to connect your display, authenticate integration requests, and maintain its settings. If your pwusage account has no email address, we may fill it from the email supplied by TRMNL.</p>
                    <p>Installation records remain until deleted. When you uninstall the integration through TRMNL and pwusage receives and verifies its uninstall notification, we delete the installation record, including its stored token and TRMNL account information. This does not delete your pwusage account, an email copied to that account, or energy history. Deleting your pwusage account also deletes the installation records you created. If an uninstall does not reach pwusage, or you want other associated data deleted, email support@fm.rodeo. Backups may retain deleted records until their normal expiration.</p>
                </SectionCard>
                <SectionCard title="Retention and your choices" bodyClassName="space-y-4">
                    <p>Server data can remain after you sign out or uninstall the app. Energy history is subject to service retention settings; account records, rate plan history, and backups have separate lifecycles. Signing out is not a request to delete your account.</p>
                    <p>You can revoke pwusage&apos;s access in your Tesla account&apos;s third-party app settings. Revoking Tesla access prevents future authorized API requests but does not automatically erase previously stored data.</p>
                    <p>You can permanently delete your pwusage account, your TRMNL records, and any sites where you are the only member (with their energy history, rate plans, and settings) at any time from <Link href="/account-delete" prefetch={false} className="text-primary underline">Delete Account</Link>. For a site shared with other members, you choose per site whether to remove only yourself (it stays available to them, including its history) or delete it for everyone. Deleting your account does not remove pwusage from your Tesla account&apos;s approved apps; we offer a link to do that after deletion. It also does not remove any solar layout in your private iCloud, which you can remove in your iPhone&apos;s iCloud settings. Backups may retain removed data until their normal expiration, and operational logs until they expire.</p>
                    <p>To request access or correction of your data, or if you cannot sign in to delete your account, email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a>. We may need to verify account ownership.</p>
                </SectionCard>
                <SectionCard title="Privacy questions and changes" bodyClassName="space-y-4">
                    <p>Email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a> with privacy questions. You can also visit our <Link href="/support" className="text-primary underline">support page</Link>. Material changes will be reflected on this page with an updated date.</p>
                </SectionCard>
            </div>
        </PageShell>
    );
}
