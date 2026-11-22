import { trmnlHeroImage } from '@/lib/og-hero-images';

// See og/home/route.ts for why these are routes rather than opengraph-image files.
export const runtime = 'nodejs';
export const dynamic = 'force-static';

export function GET() {
    return trmnlHeroImage();
}
