export const SITE_SETTINGS_SECTIONS = [
    { id: 'billing', title: 'Billing and Rate Plans', description: 'Billing start day and rate plan history' },
    { id: 'display', title: 'Display', description: 'Time zone and energy flow chart' },
    { id: 'people', title: 'People', description: 'Who has access to this home' },
    { id: 'connections', title: 'Connections', description: 'TRMNL devices, AI apps, and integration tokens' },
    { id: 'battery-saver', title: 'Battery Saver', description: 'Quick link and QR code' },
] as const;

export type SiteSettingsSection = (typeof SITE_SETTINGS_SECTIONS)[number]['id'];

export function parseSiteSettingsSection(value: unknown): SiteSettingsSection | null {
    return SITE_SETTINGS_SECTIONS.find(section => section.id === value)?.id ?? null;
}

export function siteSettingsHref(siteId: string, section?: SiteSettingsSection, date?: string): string {
    const query = new URLSearchParams({ view: 'settings' });
    if (section) query.set('section', section);
    if (date) query.set('date', date);
    return `/site/${encodeURIComponent(siteId)}?${query}`;
}
