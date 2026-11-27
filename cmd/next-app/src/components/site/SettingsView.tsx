import Link from 'next/link';
import { TimezoneDisplayForm } from '@/components/TimezoneDisplayForm';
import { SankeyRendererForm } from '@/components/SankeyRendererForm';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { H2 } from '@/components/ui/Typography';
import { DEFAULT_RENDERER_ID } from '@/lib/sankey/renderers/registry';
import { SITE_SETTINGS_SECTIONS, siteSettingsHref, type SiteSettingsSection } from '@/lib/site-settings';
import type { SiteWithTariffs, TrmnlInstallation } from '@/lib/db';
import type { SiteTariffsTimelineResponse } from '@/lib/tariff-contract';
import { BatterySaverQuickLink } from './BatterySaverQuickLink';
import { BillingSettings } from './BillingSettings';
import { Connections } from './Connections';
import { TrmnlSettings } from './TrmnlSettings';

interface SettingsViewProps {
    site: SiteWithTariffs;
    section: SiteSettingsSection | null;
    date?: string;
    installations: TrmnlInstallation[];
    memberEmails: string[];
    tariffTimeline?: SiteTariffsTimelineResponse | null;
}

function DisplaySettings({ site }: { site: SiteWithTariffs }) {
    return (
        <Card>
            <CardContent className="space-y-6 pt-6">
                <TimezoneDisplayForm siteId={site.id} initialMode={site.timezone_display_mode || 'SITE'} />
                <SankeyRendererForm
                    siteId={site.id}
                    initialRenderer={site.sankey_renderer || DEFAULT_RENDERER_ID}
                    options={[{ id: 'direct', label: 'Direct (multi-color)' }]}
                />
            </CardContent>
        </Card>
    );
}

function PeopleSettings({ emails }: { emails: string[] }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>People with Access</CardTitle>
                <CardDescription>
                    Tesla manages access to this Powerwall. Everyone listed can view this site’s shared history and settings.
                </CardDescription>
            </CardHeader>
            <CardContent>
                {emails.length > 0 ? (
                    <ul className="space-y-2" aria-label="People with access">
                        {emails.map(email => (
                            <li key={email} className="text-sm text-gray-700 dark:text-gray-200">{email}</li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-gray-700 dark:text-gray-200">No people are listed for this home.</p>
                )}
            </CardContent>
        </Card>
    );
}

function SettingsPanel({ site, section, installations, memberEmails, tariffTimeline }: SettingsViewProps) {
    switch (section) {
        case 'billing':
            return <BillingSettings key={site.id} siteId={site.id} billingDay={site.billing_start_day || 1} tariffTimeline={tariffTimeline ?? null} />;
        case 'display':
            return <DisplaySettings site={site} />;
        case 'people':
            return <PeopleSettings emails={memberEmails} />;
        case 'connections':
            return (
                <div className="space-y-6">
                    <Connections key={site.id} siteId={site.id} />
                    <TrmnlSettings key={site.id} siteId={site.id} installations={installations} />
                </div>
            );
        case 'battery-saver':
            return <BatterySaverQuickLink siteId={site.id} />;
        case null:
            return null;
    }
}

export function SettingsView(props: SettingsViewProps) {
    const { site, section, date } = props;
    const selected = SITE_SETTINGS_SECTIONS.find(item => item.id === section);
    return (
        <div className="mx-auto w-full max-w-4xl space-y-6">
            {selected && (
                <Link href={siteSettingsHref(site.id, undefined, date)} className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">
                    Back to Site Settings
                </Link>
            )}
            <H2>{selected?.title ?? 'Site Settings'}</H2>
            {selected ? <SettingsPanel {...props} /> : (
                <nav aria-label="Site settings">
                    <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-slate-700 dark:border-slate-700">
                        {SITE_SETTINGS_SECTIONS.map(item => (
                            <li key={item.id}>
                                <Link
                                    href={siteSettingsHref(site.id, item.id, date)}
                                    prefetch={false}
                                    className="flex items-center justify-between gap-4 rounded-md px-4 py-3 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-slate-800"
                                >
                                    <span>
                                        <span className="block font-medium">{item.title}</span>
                                        <span className="block text-sm text-gray-600 dark:text-gray-300">{item.description}</span>
                                    </span>
                                    <span aria-hidden="true">›</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </nav>
            )}
        </div>
    );
}
