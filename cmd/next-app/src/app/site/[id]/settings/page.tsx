import { EnergyRepo } from '@/lib/energy-repo';
import { TrmnlService } from '@/lib/trmnl-service';
import { verifySiteAccess } from '@/lib/auth-checks';
import { BillingStartDayForm } from '@/components/BillingStartDayForm';
import Link from 'next/link';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { notFound, redirect } from 'next/navigation';

export default async function SiteSettingsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    if (!await verifySiteAccess(id)) {
        redirect('/');
    }

    const repo = new EnergyRepo();
    const site = await repo.getSite(id);

    if (!site) {
        notFound();
    }

    const trmnlService = new TrmnlService();
    const installation = await trmnlService.getInstallationBySiteId(site.id);

    return (
        <div className="flex min-h-screen flex-col items-center p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="w-full max-w-2xl">
                <Breadcrumbs items={[
                    { label: site.name, href: `/site/${id}` },
                    { label: 'Settings' }
                ]} />

                <h1 className="text-3xl font-bold mb-8">Site Settings</h1>

                <div className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800">
                    <h2 className="text-xl font-semibold mb-6">Billing Configuration</h2>

                    <div className="mb-6">
                        <BillingStartDayForm siteId={site.id} initialDay={site.billing_start_day || 1} />
                        <p className="text-xs text-gray-500 mt-1">
                            Calculates monthly usage starting from this day.
                        </p>
                    </div>
                </div>


                <div className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800 mt-8">
                    <h2 className="text-xl font-semibold mb-4">Trmnl E-Ink Display</h2>
                    <p className="mb-6 text-gray-600 dark:text-gray-300">
                        Display your daily energy usage on a dedicated, always-on e-ink screen.
                    </p>

                    <div className="mb-8">
                        <div className="border-4 border-black rounded-xl p-4 max-w-sm mx-auto bg-white text-black font-sans shadow-xl relative mb-4">
                            {/* Device "Chin" mockup */}
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black opacity-10"></div>

                            <div className="flex flex-col h-full bg-white p-2">
                                <div className="mb-4">
                                    <h3 className="text-xl font-bold leading-tight">{site.name}</h3>
                                    <p className="text-xs uppercase tracking-wider text-gray-600">11/10/2025 - 12/05/2025</p>
                                </div>

                                <div className="mb-4">
                                    <div className="border-b-2 border-black mb-1">
                                        <span className="text-xs font-bold uppercase tracking-wider">Summer - Weekday</span>
                                    </div>
                                    <table className="w-full text-xs">
                                        <thead>
                                            <tr className="border-b border-black">
                                                <th className="text-left py-1">Period</th>
                                                <th className="text-right py-1">Home</th>
                                                <th className="text-right py-1">Sol</th>
                                                <th className="text-right py-1">Batt</th>
                                                <th className="text-right py-1">Grid</th>
                                                <th className="text-right py-1">Cost</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr>
                                                <td className="py-1">Off-Peak</td>
                                                <td className="text-right">12.5</td>
                                                <td className="text-right">8.2</td>
                                                <td className="text-right">4.3</td>
                                                <td className="text-right">0.0</td>
                                                <td className="text-right">$1.20</td>
                                            </tr>
                                            <tr>
                                                <td className="py-1"><b>On-Peak</b></td>
                                                <td className="text-right"><b>5.1</b></td>
                                                <td className="text-right"><b>2.0</b></td>
                                                <td className="text-right"><b>-1.0</b></td>
                                                <td className="text-right"><b>4.1</b></td>
                                                <td className="text-right"><b>$2.50</b></td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>

                                <div className="text-center mt-auto">
                                    <p className="text-xs uppercase tracking-wider mb-1">Est. Cost</p>
                                    <p className="text-4xl font-bold">$3.70</p>
                                </div>
                            </div>
                        </div>

                        <div className="text-center">
                            <Link href={`/site/${site.id}/trmnl/preview`} className="text-blue-600 hover:underline font-medium text-sm" target="_blank">
                                View Live Device Preview &rarr;
                            </Link>
                        </div>
                    </div>

                    <div className="flex gap-4 flex-col sm:flex-row">
                        {installation ? (
                            <a
                                href={installation.plugin_setting_id
                                    ? `https://usetrmnl.com/plugin_settings/${installation.plugin_setting_id}/edit`
                                    : 'https://usetrmnl.com/dashboard'}
                                target="_blank"
                                className="flex-1 bg-gray-800 text-white px-4 py-2 rounded text-center hover:bg-gray-700 transition-colors font-semibold"
                            >
                                Manage Trmnl Plugin
                            </a>
                        ) : (
                            <a
                                href="https://usetrmnl.com/plugin_settings/new?keyname=powerwall_energy_usage"
                                target="_blank"
                                className="flex-1 bg-black text-white px-4 py-2 rounded text-center hover:bg-gray-800 transition-colors font-semibold"
                            >
                                Add Trmnl Plugin
                            </a>
                        )}
                        <a
                            href="https://usetrmnl.com"
                            target="_blank"
                            className="flex-1 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-200 px-4 py-2 rounded text-center hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                        >
                            Buy Device
                        </a>
                    </div>
                </div>
            </div>
        </div >
    );
}
