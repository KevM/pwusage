import { db } from '@/lib/db';
import { PreviewClient } from './client';

import { Breadcrumbs } from '@/components/Breadcrumbs';

export const dynamic = 'force-dynamic';

export default async function Page(props: { searchParams: Promise<any> }) {
    // Get all installations with their sites, grouped by site to avoid duplicates
    const rows = db.prepare(`
        SELECT i.access_token, s.name as site_name, s.id as site_id
        FROM TrmnlInstallation i
        JOIN Site s ON i.site_id = s.id
        GROUP BY s.id
    `).all() as { access_token: string; site_name: string; site_id: string }[];

    const searchParams = typeof props?.searchParams?.then === 'function' ? await props.searchParams : props.searchParams;
    const activeSiteId = searchParams?.site_id || rows[0]?.site_id;
    const activeSite = rows.find(r => r.site_id === activeSiteId) || rows[0];

    const breadcrumbs = [
        { label: 'Dashboard', href: '/' }
    ];

    if (activeSite) {
        breadcrumbs.push({ label: activeSite.site_name, href: `/site/${activeSite.site_id}` });
    }
    breadcrumbs.push({ label: 'Trmnl Preview' });

    return (
        <div className="p-8">
            <Breadcrumbs items={breadcrumbs} />
            <h1 className="text-2xl font-bold mb-6 mt-4">Trmnl View Preview</h1>
            {rows.length > 0 ? (
                <PreviewClient tokens={rows} initialSiteId={activeSite?.site_id} />
            ) : (
                <div className="text-red-500">
                    No Trmnl installation found. Please install the plugin first.
                </div>
            )}
        </div>
    );
}
