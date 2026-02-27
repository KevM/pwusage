import React from 'react';

interface MiniSparklinePoint {
    watts: number;
}

interface MiniSparklineProps extends React.SVGAttributes<SVGSVGElement> {
    series: MiniSparklinePoint[];
    strokeClassName?: string;
    positiveStrokeClassName?: string;
    negativeStrokeClassName?: string;
    includeZero?: boolean;
    showZeroCrossings?: boolean;
    yMin?: number;
    yMax?: number;
}

const VIEWBOX_WIDTH = 32;
const VIEWBOX_HEIGHT = 12;

export function MiniSparkline({
    series,
    className,
    strokeClassName = 'text-gray-500 dark:text-gray-400',
    positiveStrokeClassName,
    negativeStrokeClassName,
    includeZero = false,
    showZeroCrossings = false,
    yMin,
    yMax,
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
    const computedMin = includeZero ? Math.min(0, ...values) : Math.min(...values);
    const computedMax = includeZero ? Math.max(0, ...values) : Math.max(...values);

    let minValue = Number.isFinite(yMin) ? (yMin as number) : computedMin;
    let maxValue = Number.isFinite(yMax) ? (yMax as number) : computedMax;

    if (includeZero) {
        minValue = Math.min(minValue, 0);
        maxValue = Math.max(maxValue, 0);
    }

    if (minValue > maxValue) {
        [minValue, maxValue] = [computedMin, computedMax];
    }

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
    const renderSignedPaths = Boolean(positiveStrokeClassName && negativeStrokeClassName);

    interface PathState {
        commands: string[];
        lastX: number | null;
        lastY: number | null;
    }

    const appendSegment = (state: PathState, x1: number, y1: number, x2: number, y2: number) => {
        const startX = x1.toFixed(2);
        const startY = y1.toFixed(2);
        const endX = x2.toFixed(2);
        const endY = y2.toFixed(2);
        const canContinue =
            state.lastX !== null &&
            state.lastY !== null &&
            Math.abs(state.lastX - x1) < 0.001 &&
            Math.abs(state.lastY - y1) < 0.001;

        if (!canContinue) {
            state.commands.push(`M ${startX} ${startY}`);
        }
        state.commands.push(`L ${endX} ${endY}`);
        state.lastX = x2;
        state.lastY = y2;
    };

    const positivePathState: PathState = { commands: [], lastX: null, lastY: null };
    const negativePathState: PathState = { commands: [], lastX: null, lastY: null };

    if (renderSignedPaths) {
        for (let i = 0; i < values.length - 1; i++) {
            const v1 = values[i];
            const v2 = values[i + 1];
            const x1 = 1 + (i * xStep);
            const x2 = 1 + ((i + 1) * xStep);
            const y1 = toY(v1);
            const y2 = toY(v2);

            if ((v1 >= 0 && v2 >= 0) || (v1 === 0 && v2 === 0)) {
                appendSegment(positivePathState, x1, y1, x2, y2);
                continue;
            }
            if (v1 <= 0 && v2 <= 0) {
                appendSegment(negativePathState, x1, y1, x2, y2);
                continue;
            }
            if (v1 === v2) continue;

            const t = (0 - v1) / (v2 - v1);
            const crossingX = x1 + ((x2 - x1) * t);
            const crossingY = toY(0);

            if (v1 > 0 && v2 < 0) {
                appendSegment(positivePathState, x1, y1, crossingX, crossingY);
                appendSegment(negativePathState, crossingX, crossingY, x2, y2);
            } else if (v1 < 0 && v2 > 0) {
                appendSegment(negativePathState, x1, y1, crossingX, crossingY);
                appendSegment(positivePathState, crossingX, crossingY, x2, y2);
            } else if (v1 === 0) {
                if (v2 > 0) appendSegment(positivePathState, x1, y1, x2, y2);
                else appendSegment(negativePathState, x1, y1, x2, y2);
            } else if (v2 === 0) {
                if (v1 > 0) appendSegment(positivePathState, x1, y1, x2, y2);
                else appendSegment(negativePathState, x1, y1, x2, y2);
            }
        }
    }

    const positivePath = positivePathState.commands.join(' ');
    const negativePath = negativePathState.commands.join(' ');

    const zeroLineY = includeZero && minValue < 0 && maxValue > 0 ? toY(0) : null;
    const zeroCrossings = zeroLineY === null || !showZeroCrossings
        ? []
        : values
            .slice(1)
            .map((value, idx) => {
                const leftValue = values[idx];
                const rightValue = value;
                const leftX = 1 + (idx * xStep);
                const rightX = 1 + ((idx + 1) * xStep);
                if (leftValue === rightValue) return null;
                const hasCrossing = (leftValue < 0 && rightValue > 0) || (leftValue > 0 && rightValue < 0);
                if (!hasCrossing) return null;
                const t = (0 - leftValue) / (rightValue - leftValue);
                const crossingX = leftX + (rightX - leftX) * t;
                return { x: crossingX, y: zeroLineY };
            })
            .filter((crossing): crossing is { x: number; y: number } => crossing !== null);

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
                    opacity={showZeroCrossings ? 0.32 : 0.18}
                    strokeDasharray="1.5 1.5"
                    className={strokeClassName}
                />
            ) : null}
            {zeroLineY !== null && showZeroCrossings ? (
                <line
                    x1="0.35"
                    y1={zeroLineY}
                    x2="2.15"
                    y2={zeroLineY}
                    stroke="currentColor"
                    strokeWidth="1.1"
                    opacity="0.75"
                    strokeLinecap="round"
                    className={strokeClassName}
                />
            ) : null}
            {renderSignedPaths ? (
                <>
                    {negativePath ? (
                        <path
                            d={negativePath}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={negativeStrokeClassName}
                        />
                    ) : null}
                    {positivePath ? (
                        <path
                            d={positivePath}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={positiveStrokeClassName}
                        />
                    ) : null}
                </>
            ) : (
                <path
                    d={path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={strokeClassName}
                />
            )}
            {zeroCrossings.map((crossing, idx) => (
                <line
                    key={`zero-crossing-${idx}`}
                    x1={crossing.x}
                    y1={crossing.y - 1.7}
                    x2={crossing.x}
                    y2={crossing.y + 1.7}
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                    className={strokeClassName}
                />
            ))}
        </svg>
    );
}
