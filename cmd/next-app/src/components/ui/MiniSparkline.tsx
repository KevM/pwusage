import React from 'react';

interface MiniSparklinePoint {
    watts: number;
}

interface MiniSparklineProps extends React.SVGAttributes<SVGSVGElement> {
    series: MiniSparklinePoint[];
    strokeClassName?: string;
    includeZero?: boolean;
}

const VIEWBOX_WIDTH = 32;
const VIEWBOX_HEIGHT = 12;

export function MiniSparkline({
    series,
    className,
    strokeClassName = 'text-gray-500 dark:text-gray-400',
    includeZero = false,
    ...props
}: MiniSparklineProps) {
    if (series.length === 0) {
        return (
            <svg
                viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
                className={className}
                aria-hidden="true"
                {...props}
            >
                <line
                    x1="1"
                    y1={VIEWBOX_HEIGHT / 2}
                    x2={VIEWBOX_WIDTH - 1}
                    y2={VIEWBOX_HEIGHT / 2}
                    className={strokeClassName}
                    stroke="currentColor"
                    strokeWidth="1.25"
                    opacity="0.35"
                    strokeLinecap="round"
                />
            </svg>
        );
    }

    if (series.length === 1) {
        return (
            <svg
                viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
                className={className}
                aria-hidden="true"
                {...props}
            >
                <circle
                    cx={VIEWBOX_WIDTH / 2}
                    cy={VIEWBOX_HEIGHT / 2}
                    r="1.5"
                    className={strokeClassName}
                    fill="currentColor"
                    opacity="0.75"
                />
            </svg>
        );
    }

    const values = series.map((point) => point.watts);
    const minValue = includeZero ? Math.min(0, ...values) : Math.min(...values);
    const maxValue = includeZero ? Math.max(0, ...values) : Math.max(...values);
    const range = maxValue - minValue || 1;
    const xStep = (VIEWBOX_WIDTH - 2) / (series.length - 1);

    const toY = (value: number) => {
        const normalized = (value - minValue) / range;
        return 1 + ((1 - normalized) * (VIEWBOX_HEIGHT - 2));
    };

    const path = values
        .map((value, index) => {
            const x = 1 + (index * xStep);
            const y = toY(value);
            return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
        })
        .join(' ');

    const zeroLineY = includeZero && minValue < 0 && maxValue > 0 ? toY(0) : null;

    return (
        <svg
            viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
            className={className}
            aria-hidden="true"
            {...props}
        >
            {zeroLineY !== null ? (
                <line
                    x1="1"
                    y1={zeroLineY}
                    x2={VIEWBOX_WIDTH - 1}
                    y2={zeroLineY}
                    stroke="currentColor"
                    strokeWidth="0.75"
                    opacity="0.18"
                    strokeDasharray="1.5 1.5"
                    className={strokeClassName}
                />
            ) : null}
            <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={strokeClassName}
            />
        </svg>
    );
}
