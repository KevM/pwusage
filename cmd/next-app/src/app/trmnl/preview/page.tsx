import { db } from '@/lib/db';
import { PreviewClient } from './client';

export const dynamic = 'force-dynamic';

export default function Page() {
    // Get all installations with their sites, grouped by site to avoid duplicates
    const rows = db.prepare(`
        SELECT i.access_token, s.name as site_name 
        FROM TrmnlInstallation i
        JOIN Site s ON i.site_id = s.id
        GROUP BY s.id
    `).all() as { access_token: string; site_name: string }[];

    return (
        <div className="p-8">
            <h1 className="text-2xl font-bold mb-6">Trmnl View Preview</h1>
            {rows.length > 0 ? (
                <PreviewClient tokens={rows} />
            ) : (
                <div className="text-red-500">
                    No Trmnl installation found. Please install the plugin first.
                </div>
            )}
        </div>
    );
}
