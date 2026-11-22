import type { Metadata } from 'next';

/**
 * Link-preview (Open Graph / Twitter card) metadata. Unfurlers such as Discord, Slack, X and
 * iMessage pick the card size from `twitter:card`: `summary` is a small thumbnail beside the
 * text, `summary_large_image` a full-width banner. Pages default to the small card with the app
 * icon; only pages with a real hero image (a screenshot worth seeing) use the large card.
 *
 * A page's `openGraph` replaces the layout's whole object, so every page that sets one goes
 * through here to keep title, description and site name together.
 */

export const SITE_NAME = 'pwusage';

/** The site title; preview deployments (pwusagebeta) say so. */
export const APP_TITLE = process.env.VERCEL_ENV === 'preview' ? 'Powerwall Usage (Preview)' : 'Powerwall Usage';

/** The product in one sentence (docs/voice-and-terms.md). */
export const DEFAULT_DESCRIPTION =
    'Run heavy energy use when grid power is cheapest, and save your battery for when rates spike.';

export const HERO_IMAGE_SIZE = { width: 1200, height: 630 } as const;

const ICON_IMAGE = { url: '/icon.png', width: 1024, height: 1024 } as const;

export interface SocialMetadataInput {
    title: string;
    description: string;
    /**
     * Omit for the small card. Otherwise a 1200×630 image, served from an `/og/*` route so the
     * URL resolves against `metadataBase` (see src/app/og/home/route.ts).
     */
    hero?: {
        url: string;
        alt: string;
        /** `null` when the size is unknown (e.g. an image from a news post). */
        size?: { width: number; height: number } | null;
    };
}

export function socialMetadata({ title, description, hero }: SocialMetadataInput): Pick<Metadata, 'openGraph' | 'twitter'> {
    const openGraph: NonNullable<Metadata['openGraph']> = {
        title,
        description,
        siteName: SITE_NAME,
        locale: 'en_US',
        type: 'website',
    };

    openGraph.images = hero
        ? [{ url: hero.url, ...(hero.size === undefined ? HERO_IMAGE_SIZE : hero.size), alt: hero.alt }]
        : [ICON_IMAGE];

    return {
        openGraph,
        twitter: { card: hero ? 'summary_large_image' : 'summary', title, description },
    };
}
