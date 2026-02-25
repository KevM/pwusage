import React from 'react';

import { Badge } from '@/components/ui/Badge';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';
type LabelStyle = 'badge' | 'text';
type SurfaceStyle = 'boxed' | 'flat';

interface LiveMetricChipProps extends React.HTMLAttributes<HTMLDivElement> {
    label: string;
    value: React.ReactNode;
    labelVariant?: BadgeVariant;
    labelStyle?: LabelStyle;
    surfaceStyle?: SurfaceStyle;
    trailing?: React.ReactNode;
    valueClassName?: string;
}

export function LiveMetricChip({
    className = '',
    label,
    value,
    labelVariant = 'default',
    labelStyle = 'badge',
    surfaceStyle = 'boxed',
    trailing,
    valueClassName = '',
    ...props
}: LiveMetricChipProps) {
    const isBoxed = surfaceStyle === 'boxed';

    return (
        <div
            className={`inline-flex items-center ${isBoxed ? 'gap-2 rounded-lg border border-gray-200 bg-white/80 px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900/70' : 'gap-1.5 px-0 py-0'} ${className}`}
            {...props}
        >
            {labelStyle === 'badge' ? (
                <Badge variant={labelVariant} className="px-2 py-0.5 uppercase tracking-wide">
                    {label}
                </Badge>
            ) : (
                <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    {label}
                </span>
            )}
            <span className={`text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100 ${valueClassName}`}>
                {value}
            </span>
            {trailing ? <span className="inline-flex items-center">{trailing}</span> : null}
        </div>
    );
}
