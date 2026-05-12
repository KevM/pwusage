import { CHARGING_PATH, DISCHARGING_PATH, ICON_ROTATION } from '@/lib/trmnl/icons';

export type BatteryStatus = 'charging' | 'discharging' | 'idle';

export interface BatteryStatusGlyphProps {
    status: BatteryStatus;
    className?: string;
    size?: string;
}

/**
 * Battery status indicators matching TRMNL hardware display glyphs.
 */
export function BatteryStatusGlyph({ status, className, size = 'h-4 w-4' }: BatteryStatusGlyphProps) {
    if (status === 'idle') return null;
    
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
            className={`${size} ${className}`}
            fill={status === 'charging' ? 'currentColor' : 'none'}
            stroke={status === 'discharging' ? 'currentColor' : 'none'}
            strokeWidth={status === 'discharging' ? 3 : undefined}
            strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
        >
            {status === 'charging' ? (
                /* Trmnl Charging Icon: Rotated Bolt */
                <path d={CHARGING_PATH} transform={ICON_ROTATION} />
            ) : (
                /* Trmnl Discharging Icon: Rotated Source/Signal */
                <path d={DISCHARGING_PATH} transform={ICON_ROTATION} />
            )}
        </svg>
    );
}


export interface BatteryGlyphProps {
    level: number; // 0-100
    className?: string;
    strokeClass?: string;
    fillClass?: string;
}

/**
 * Large battery body glyph with dynamic fill level.
 */
export function BatteryGlyph({ level, className = 'h-6 w-12', strokeClass, fillClass }: BatteryGlyphProps) {
    const safeLevel = Math.max(0, Math.min(100, level));
    const fillWidth = (safeLevel / 100) * 18;

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 12"
            className={className}
            aria-hidden="true"
        >
            <rect
                x="0.5" y="0.5" width="20" height="11" rx="1.5"
                fill="none"
                className={strokeClass || 'stroke-emerald-500'}
                strokeWidth={1.5}
            />
            <path
                d="M21 4h2a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-2V4z"
                className={fillClass || 'fill-emerald-500'}
            />
            <rect
                x="2" y="2" width={fillWidth} height="8" rx="0.5"
                className={fillClass || 'fill-emerald-500'}
            />
        </svg>
    );
}
