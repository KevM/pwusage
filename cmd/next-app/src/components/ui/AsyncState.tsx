import React from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/Alert';
import { SectionCard } from '@/components/ui/SectionCard';
import { Spinner } from '@/components/ui/Spinner';

interface LoadingPanelProps extends React.HTMLAttributes<HTMLDivElement> {
    title?: string;
    description?: string;
}

export function LoadingPanel({
    className = '',
    title = 'Loading',
    description,
    ...props
}: LoadingPanelProps) {
    return (
        <SectionCard className={className} {...props}>
            <div className="flex items-start gap-3">
                <Spinner size="md" className="mt-0.5 shrink-0" />
                <div className="min-w-0 space-y-1">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{title}</p>
                    {description ? <p className="text-sm text-gray-600 dark:text-gray-300">{description}</p> : null}
                </div>
            </div>
        </SectionCard>
    );
}

interface ErrorPanelProps extends React.HTMLAttributes<HTMLDivElement> {
    title?: string;
    message: React.ReactNode;
    action?: React.ReactNode;
}

export function ErrorPanel({
    className = '',
    title = 'Error',
    message,
    action,
    ...props
}: ErrorPanelProps) {
    return (
        <SectionCard className={className} {...props}>
            <Alert variant="danger">
                <AlertTitle>{title}</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
            </Alert>
            {action ? <div className="mt-4">{action}</div> : null}
        </SectionCard>
    );
}
