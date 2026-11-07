import { formatTouName } from '@/lib/format-utils';
import type { SiteLiveDataHeadroom } from '@/lib/site-live-data-client';
import { LOAD_GLYPH_ICONS, LOAD_GLYPH_TONES } from './load-glyph-icons';

export interface LoadHeadroomGlyphProps {
    headroom: SiteLiveDataHeadroom | null | undefined;
}

/** Smart Shift bank words: positive kWh is banked, negative is owed. */
function bankText(kwh: number): string {
    const rounded = Math.round(Math.abs(kwh));
    return kwh < 0 ? `${rounded} kWh owed` : `${rounded} kWh banked`;
}

export function LoadHeadroomGlyph({ headroom }: LoadHeadroomGlyphProps) {
    if (!headroom) return null;

    const Icon = LOAD_GLYPH_ICONS[headroom.glyph ?? 'none'];
    const tone = LOAD_GLYPH_TONES[headroom.glyph ?? 'none'];

    const summary = headroom.profileLabel
        ? `${formatTouName(headroom.periodName)} · ${bankText(headroom.surplusKwh)} · ${headroom.profileLabel}`
        : `${formatTouName(headroom.periodName)} · ${bankText(headroom.surplusKwh)} · wait for a cheaper rate period`;

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
