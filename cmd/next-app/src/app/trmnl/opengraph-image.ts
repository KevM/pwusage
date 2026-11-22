import { trmnlHeroImage } from '@/lib/og-hero-images';
import { HERO_IMAGE_SIZE } from '@/lib/social-metadata';

export const runtime = 'nodejs';
export const alt = 'A TRMNL e-ink display showing today’s energy and the bill so far by rate period';
export const size = HERO_IMAGE_SIZE;
export const contentType = 'image/png';

export default function Image() {
    return trmnlHeroImage();
}
