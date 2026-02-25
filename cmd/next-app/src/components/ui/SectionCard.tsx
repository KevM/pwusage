import React from 'react';

import { Card, CardBody, CardDescription, CardHeader, CardProps, CardTitle } from '@/components/ui/Card';

export interface SectionCardProps extends Omit<CardProps, 'title'> {
    title?: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
    headerClassName?: string;
    bodyClassName?: string;
}

export function SectionCard({
    className = '',
    children,
    density = 'default',
    title,
    description,
    action,
    headerClassName = '',
    bodyClassName = '',
    ...props
}: SectionCardProps) {
    const hasHeader = title || description || action;

    return (
        <Card className={className} density={density} {...props}>
            {hasHeader ? (
                <CardHeader action={action} density={density} className={headerClassName}>
                    {title ? <CardTitle density={density}>{title}</CardTitle> : null}
                    {description ? <CardDescription>{description}</CardDescription> : null}
                </CardHeader>
            ) : null}
            <CardBody density={density} className={bodyClassName}>
                {children}
            </CardBody>
        </Card>
    );
}
