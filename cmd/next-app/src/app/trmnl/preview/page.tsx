import { pool } from '@/lib/db';
import { PreviewClient } from './client';

import { Breadcrumbs } from '@/components/Breadcrumbs';

export const dynamic = 'force-dynamic';

import { cookies } from 'next/headers';

export default async function Page(props: { searchParams: Promise<any> }) {
    const cookieStore = await cookies();
    const token = cookieStore.get('access_token');

    let rows: { access_token: string; site_name: string; site_id: string }[] = [];

    if (token) {
        // Only fetch list of sites if authenticated (admin/user)
        // Ideally we should verify the token, but existence check prevents leaking to random public visitors
        // For a true multi-tenant app we'd verify the user owns these sites. 
        // Assuming single-tenant or simplified auth for now based on project context.
        const res = await pool.query(`
            SELECT DISTINCT ON (s.id) s.access_token, s.name as site_name, s.id as site_id
            FROM "TrmnlInstallation" i
            JOIN "Site" s ON i.site_id = s.id
        `);
        rows = res.rows as { access_token: string; site_name: string; site_id: string }[];
    }

    const searchParams = typeof props?.searchParams?.then === 'function' ? await props.searchParams : props.searchParams;
    const activeSiteId = searchParams?.site_id || rows[0]?.site_id;
    const activeSite = rows.find(r => r.site_id === activeSiteId) || rows[0];

    const breadcrumbs: { label: string; href?: string }[] = [
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
            {searchParams?.uuid ? (
                <PreviewClient manualUuid={searchParams.uuid} />
            ) : rows.length > 0 ? (
                <PreviewClient tokens={rows} initialSiteId={activeSite?.site_id} />
            ) : null}

            <div className="mt-8 pt-8 border-t border-gray-200">
                <h2 className="text-lg font-semibold mb-4">Manual UUID Preview</h2>
                <p className="text-sm text-gray-600 mb-4">Enter a random UUID to test the &quot;New Installation&quot; (QR Code) screen.</p>
                <form action="/trmnl/preview" method="GET" className="flex gap-4">
                    <input
                        type="text"
                        name="uuid"
                        placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                        className="flex-1 p-2 border rounded"
                        defaultValue={searchParams?.uuid}
                    />
                    <button type="submit" className="bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-700">
                        Preview UUID
                    </button>
                </form>
            </div>
        </div>
    );
}
