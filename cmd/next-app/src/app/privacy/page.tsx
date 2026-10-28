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
            <PageHeader title="Privacy Policy" description="For the pwusage website and iOS app. Updated October 2, 2026." className="mb-8" />
            <div className="space-y-6 text-gray-700 dark:text-gray-300">
                <p>pwusage helps you understand your Powerwall energy use, estimate electricity costs, and manage optional battery holds. This policy explains what information those features use.</p>
                <SectionCard title="Tesla account and energy information" bodyClassName="space-y-4">
                    <p>When you connect Tesla, Tesla handles your sign-in. pwusage receives account identifiers, your email address when provided by Tesla, and authorization tokens for the permissions you grant. We do not receive your Tesla password.</p>
                    <p>Our server stores connected energy-site information, including site names, identifiers, utility and time zone information, energy readings, battery status, tariffs, and settings. Tesla site responses may include location information. We use this data to show your dashboard, history, bill estimates, and load-timing information.</p>
                    <p>If you are in the automatic solar forecast beta and share your location from the app, pwusage stores your home&apos;s approximate location, rounded to about 1 km, and uses it with your solar production history to work out which way your solar panels face, how steeply they are tilted and how large they are. The app sends that rounded location and your panels&apos; direction, tilt and size from your device to Forecast.Solar to get a solar forecast.</p>
                    <p>If you use Battery Hold and grant the required command permission, pwusage stores hold settings and status and sends the reserve changes you request to Tesla. Scheduled checks use energy readings to monitor and restore holds.</p>
                </SectionCard>
                <SectionCard title="Information on your device" bodyClassName="space-y-4">
                    <p>The iOS app stores your session, selected site, preferences, appliance load profiles, and cached dashboard and forecast data on your device. Cached readings can remain visible offline and retain their original timestamps.</p>
                    <p>Solcast is optional. If you connect it, your API key is stored in the iOS Keychain and sent directly from your device to Solcast to request your rooftop sites and forecasts. The app does not send that key to the pwusage server. Forecast settings and cached forecasts are stored locally.</p>
                    <p>Signing out clears the app&apos;s saved dashboard data and account-scoped forecast credentials and state. Removing the app removes its local app data; iOS Keychain items may persist separately.</p>
                </SectionCard>
                <SectionCard title="How information is used and shared" bodyClassName="space-y-4">
                    <p>We use account and energy information to provide the features you request, keep your connection working, and investigate service problems. We do not sell your personal data or use it for advertising tracking.</p>
                    <p>The service runs on Vercel and uses a hosted PostgreSQL database on Supabase. Those providers process information needed to host and operate pwusage. Requests may produce operational logs containing technical details such as request paths, identifiers, IP addresses, and errors.</p>
                    <p>Tesla processes your sign-in and API requests under its own privacy policy. Solcast processes requests when you enable its integration. Forecast.Solar processes forecast requests from the app for users in the automatic solar forecast beta. Support services receive information you choose to submit.</p>
                </SectionCard>
                <SectionCard title="TRMNL integration" bodyClassName="space-y-4">
                    <p>If you install a TRMNL integration, pwusage shares the dashboard information needed to render your connected display. Our server stores your TRMNL OAuth access token, account and installation identifiers, display settings, and account information supplied by TRMNL, including your email address. We use these records to connect your display, authenticate integration requests, and maintain its settings. If your pwusage account has no email address, we may fill it from the email supplied by TRMNL.</p>
                    <p>Installation records remain until deleted. When you uninstall the integration through TRMNL and pwusage receives and verifies its uninstall notification, we delete the installation record, including its stored token and TRMNL account information. This does not delete your pwusage account, an email copied to that account, or energy history. If an uninstall does not reach pwusage, or you want other associated data deleted, email support@fm.rodeo. Backups may retain deleted records until their normal expiration.</p>
                </SectionCard>
                <SectionCard title="Retention and your choices" bodyClassName="space-y-4">
                    <p>Server data can remain after you sign out or uninstall the app. Energy history is subject to service retention settings; account records, tariff history, and backups have separate lifecycles. Signing out is not a request to delete your account.</p>
                    <p>You can revoke pwusage&apos;s access in your Tesla account&apos;s third-party app settings and remove the optional Solcast connection in the app. Revoking Tesla access prevents future authorized API requests but does not automatically erase previously stored data.</p>
                    <p>To request access, correction, or deletion of your pwusage account and associated data, email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a>. We may need to verify account ownership. Backups may retain removed data until their normal expiration.</p>
                </SectionCard>
                <SectionCard title="Privacy questions and changes" bodyClassName="space-y-4">
                    <p>Email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a> with privacy questions. You can also visit our <Link href="/support" className="text-primary underline">support page</Link>. Material changes will be reflected on this page with an updated date.</p>
                </SectionCard>
            </div>
        </PageShell>
    );
}
