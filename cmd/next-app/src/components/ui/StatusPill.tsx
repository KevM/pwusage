import React from 'react';

import { Badge } from '@/components/ui/Badge';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';

export interface StatusPillProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
    status?: string | null;
    label?: React.ReactNode;
    fallbackLabel?: string;
}

function normalizeStatus(status?: string | null): string {
    return (status ?? '').trim().toLowerCase();
}

function resolveVariant(normalizedStatus: string): BadgeVariant {
    if (['ok', 'healthy', 'active', 'linked', 'online', 'enabled', 'success', 'connected', 'complete', 'completed'].includes(normalizedStatus)) {
        return 'success';
    }

    if (['warning', 'warn', 'degraded', 'pending', 'stale', 'unlinked'].includes(normalizedStatus)) {
        return 'warning';
    }

    if (['error', 'failed', 'failure', 'inactive', 'offline', 'disabled', 'disconnected'].includes(normalizedStatus)) {
        return 'danger';
    }

    if (['running', 'loading', 'syncing', 'processing'].includes(normalizedStatus)) {
        return 'info';
    }

    return 'default';
}

function formatLabel(normalizedStatus: string, fallbackLabel: string): string {
    if (!normalizedStatus) return fallbackLabel;

    return normalizedStatus
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

export function StatusPill({
    className = '',
    status,
    label,
    fallbackLabel = 'Unknown',
    ...props
}: StatusPillProps) {
    const normalizedStatus = normalizeStatus(status);
    const content = label ?? formatLabel(normalizedStatus, fallbackLabel);

    return (
        <Badge className={className} variant={resolveVariant(normalizedStatus)} {...props}>
            {content}
        </Badge>
    );
}
