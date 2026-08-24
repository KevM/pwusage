import type { ComponentType } from 'react';
import { formatTouName } from '@/lib/format-utils';
import type { LoadGlyph } from '@/lib/load-profiles';
import type { SiteLiveDataHeadroom } from '@/lib/site-live-data-client';

const ICON_PROPS = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'h-3.5 w-3.5',
    'aria-hidden': true,
};

function CarIcon() {
    return (
        <svg {...ICON_PROPS}>
            <path d="M3 13.5l1.8-5.4A2 2 0 016.7 6.75h10.6a2 2 0 011.9 1.35l1.8 5.4" />
            <path d="M3 13.5h18v4.5H3z" />
            <path d="M6.75 18v1.5M17.25 18v1.5" />
        </svg>
    );
}

function ApplianceIcon() {
    return (
        <svg {...ICON_PROPS}>
            <rect x="4.5" y="3" width="15" height="18" rx="2" />
            <circle cx="12" cy="14" r="4" />
            <path d="M8 6.5h.01M11 6.5h.01" />
        </svg>
    );
}

function SmallIcon() {
    return (
        <svg {...ICON_PROPS}>
            <path d="M9 18h6M10 21h4" />
            <path d="M12 3a6 6 0 00-3.5 10.9V15h7v-1.1A6 6 0 0012 3z" />
        </svg>
    );
}

function AvoidIcon() {
    return (
        <svg {...ICON_PROPS}>
            <path d="M12 3l9 16H3l9-16z" />
            <path d="M12 9.5v4M12 16.5h.01" />
        </svg>
    );
}

const ICONS: Record<LoadGlyph, ComponentType> = {
    car: CarIcon,
    appliance: ApplianceIcon,
    small: SmallIcon,
};

const TONES: Record<LoadGlyph | 'none', string> = {
    car: 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950/40',
    appliance: 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950/40',
    small: 'text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/40',
    none: 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950/40',
};

export interface LoadHeadroomGlyphProps {
    headroom: SiteLiveDataHeadroom | null | undefined;
}

export function LoadHeadroomGlyph({ headroom }: LoadHeadroomGlyphProps) {
    if (!headroom) return null;

    const Icon = headroom.glyph ? ICONS[headroom.glyph] : AvoidIcon;
    const tone = TONES[headroom.glyph ?? 'none'];

    const summary = headroom.profileLabel
        ? `${formatTouName(headroom.periodName)} · ${Math.round(headroom.surplusKwh)} kWh surplus — ${headroom.profileLabel}`
        : `${formatTouName(headroom.periodName)} · ${Math.round(headroom.surplusKwh)} kWh — avoid large loads`;

    return (
        <span
            title={summary}
            className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 ${tone}`}
        >
            <Icon />
            <span className="sr-only">{summary}</span>
        </span>
    );
}
