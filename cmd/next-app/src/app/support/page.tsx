import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';

export const metadata: Metadata = {
    title: 'Support | Powerwall Usage',
    description: 'Get help with the pwusage iOS app, Tesla sign-in, energy readings, and account or privacy requests.',
    alternates: { canonical: '/support' },
};

export default function SupportPage() {
    return (
        <PageShell maxWidth="lg" padding="default" fullHeight={false}>
            <PageHeader title="pwusage Support" description="Help with the iOS app and Powerwall Usage website." className="mb-8" />
            <div className="space-y-6 text-gray-700 dark:text-gray-300">
                <SectionCard title="Contact and report a problem" bodyClassName="space-y-4">
                    <p>Email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a> for help with pwusage.</p>
                    <p>Join the <a href="https://discord.gg/KCweVtVNAB" className="text-primary underline" target="_blank" rel="noopener noreferrer">pwusage Discord community</a> for help from the maintainer and other users. You can also <a href="https://github.com/KevM/pwusage/issues" className="text-primary underline" target="_blank" rel="noopener noreferrer">report a bug on GitHub</a>.</p>
                    <p>Include your app version and build number from TestFlight, your iOS version, what you expected to happen, and the steps that reproduce the problem. For the website, include your browser and the page where the problem occurs.</p>
                    <p>Discord and GitHub are public channels. Do not post passwords, authorization tokens, Solcast API keys, home addresses, or private account information. Redact screenshots before sharing them.</p>
                </SectionCard>
                <SectionCard title="Sign-in and connected sites" bodyClassName="space-y-4">
                    <p>pwusage requires a Tesla account with access to a supported energy site. Sign-in opens Tesla&apos;s secure login flow. If your session has expired, sign in again. A Tesla account that only has vehicles will not provide a Powerwall dashboard.</p>
                    <p>If a feature asks you to reconnect Tesla, review and grant the requested permission. Battery Hold requires Energy Product Commands permission to change your backup reserve.</p>
                </SectionCard>
                <SectionCard title="Stale readings or connection problems" bodyClassName="space-y-4">
                    <p>Check your connection, then pull down on the dashboard to refresh. The app can display saved data while offline; check its timestamps and saved-data notice. Missing or old battery charge appears as unknown rather than a fresh reading.</p>
                    <p>Bill estimates depend on saved tariff and energy data and may differ from your utility bill. If the app says it is newer than the server, report the message and app build number so we can check the deployment.</p>
                </SectionCard>
                <SectionCard title="Battery Hold and solar forecasts" bodyClassName="space-y-4">
                    <p>Battery Hold changes your Tesla backup reserve after confirmation. Stopping a hold restores the reserve saved when it started. If status is unavailable, retry before starting another hold. You can also inspect your current reserve in Tesla&apos;s app.</p>
                    <p>Solcast forecasts are optional and require your own API key and rooftop site. Follow the <Link href="/help/solcast" className="text-primary underline">Solcast setup guide</Link> to connect one. Check the forecast status message for connection, setup, or household-history problems. You can disconnect Solcast without disconnecting Tesla.</p>
                </SectionCard>
                <SectionCard title="Account and privacy requests" bodyClassName="space-y-4">
                    <p>For an account-data or deletion request, email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a>. We may need to verify account ownership before acting on your request. Signing out or uninstalling does not delete your server account. Revoking access in Tesla stops future authorized requests.</p>
                    <p>Read our <Link href="/privacy" className="text-primary underline">privacy policy</Link> for details about account information, energy history, and local app data.</p>
                </SectionCard>
                <SectionCard title="TRMNL display help">
                    <p>For display installation and setup, see the <Link href="/help/trmnl" className="text-primary underline">TRMNL guide</Link>.</p>
                </SectionCard>
            </div>
        </PageShell>
    );
}
