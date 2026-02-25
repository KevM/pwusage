import React from 'react';

interface BatteryStatusGlyphProps extends React.SVGAttributes<SVGSVGElement> {
    percentage: number;
    powerWatts?: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function BatteryStatusGlyph({
    percentage,
    powerWatts = 0,
    className,
    ...props
}: BatteryStatusGlyphProps) {
    const normalized = clamp(Number.isFinite(percentage) ? percentage : 0, 0, 100);
    const fillWidth = 10.5 * (normalized / 100);
    const isCharging = powerWatts < -100;
    const isDischarging = powerWatts > 100;

    return (
        <svg
            viewBox="0 0 18 10"
            className={className}
            role="img"
            aria-label={`Battery ${Math.round(normalized)} percent`}
            {...props}
        >
            <rect x="0.75" y="1.25" width="14" height="7.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="15.2" y="3.1" width="2" height="3.8" rx="0.8" fill="currentColor" opacity="0.9" />
            <rect
                x="2.1"
                y="2.6"
                width={Math.max(0.8, fillWidth)}
                height="4.8"
                rx="0.8"
                fill="currentColor"
                opacity={normalized <= 10 ? 0.45 : 0.9}
            />
            {isCharging ? (
                <path
                    d="M9.4 2.4 7.3 5h1.6L8 7.6l2.6-3.1h-1.7l.5-2.1Z"
                    fill="white"
                    opacity="0.95"
                />
            ) : null}
            {isDischarging ? (
                <path
                    d="M6.1 5h5.8"
                    fill="none"
                    stroke="white"
                    strokeWidth="1"
                    strokeLinecap="round"
                    opacity="0.95"
                />
            ) : null}
        </svg>
    );
}

