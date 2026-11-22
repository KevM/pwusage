import { homeHeroImage } from '@/lib/og-hero-images';

// Link-preview hero for the sign-in page. Not an opengraph-image file: one at the app root
// would become every page's image, and other pages should keep the small card.
export const runtime = 'nodejs';
export const dynamic = 'force-static';

export function GET() {
    return homeHeroImage();
}
