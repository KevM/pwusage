import { iosHeroImage } from '@/lib/og-hero-images';
import { HERO_IMAGE_SIZE } from '@/lib/social-metadata';

export const runtime = 'nodejs';
export const alt = 'The pwusage iPhone app: live power, the bill so far and Smart Shift';
export const size = HERO_IMAGE_SIZE;
export const contentType = 'image/png';

export default function Image() {
    return iosHeroImage();
}
