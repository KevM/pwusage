import { homeHeroImage } from '@/lib/og-hero-images';

// Link-preview hero images are plain routes, not opengraph-image files: on Vercel preview
// deploys Next points file-based images at the per-deploy *.vercel.app host, and one at the
// app root would become every page's image.
export const runtime = 'nodejs';
export const dynamic = 'force-static';

export function GET() {
    return homeHeroImage();
}
