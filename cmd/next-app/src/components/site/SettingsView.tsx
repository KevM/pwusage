'use client';

import { BillingStartDayForm } from '@/components/BillingStartDayForm';
import Link from 'next/link';
import Image from 'next/image';


import { Site, TrmnlInstallation } from '@/lib/db';

interface SettingsViewProps {
    site: Site;
    // TrmnlInstallation can be undefined if not found
    installation: TrmnlInstallation | undefined;
}

export function SettingsView({ site, installation }: SettingsViewProps) {
    // Trmnl Preview logic extracted from Settings Page
    return (
        <div className="w-full max-w-2xl mx-auto">
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
                    <div className="relative aspect-video w-full max-w-lg mx-auto bg-gray-100 dark:bg-gray-900 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800 shadow-sm mb-4">
                        <Image
                            src="/trmn-plugin.png"
                            alt="Trmnl E-ink Display showing Energy Dashboard"
                            fill
                            className="object-cover"
                        />
                    </div>

                    <div className="text-center mb-4">
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
    );
}
