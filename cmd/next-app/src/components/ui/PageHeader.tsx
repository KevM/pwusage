import React from 'react';

type PageHeaderTitleTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
type PageHeaderDensity = 'compact' | 'default';

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
    title: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
    eyebrow?: React.ReactNode;
    titleTag?: PageHeaderTitleTag;
    density?: PageHeaderDensity;
}

export function PageHeader({
    className = '',
    title,
    description,
    actions,
    eyebrow,
    titleTag = 'h1',
    density = 'default',
    ...props
}: PageHeaderProps) {
    const TitleTag = titleTag;
    const titleClass = density === 'compact' ? 'text-2xl sm:text-3xl' : 'text-3xl sm:text-4xl';
    const titleColorClass = titleTag === 'h1' ? 'text-primary' : 'text-gray-900 dark:text-white';
    const containerGapClass = density === 'compact' ? 'gap-3' : 'gap-4';
    const actionsGapClass = density === 'compact' ? 'gap-2' : 'gap-3';
    const stackGapClass = density === 'compact' ? 'space-y-1' : 'space-y-1.5';

    return (
        <div className={`flex flex-col ${containerGapClass} sm:flex-row sm:items-start sm:justify-between ${className}`} {...props}>
            <div className={`min-w-0 flex-1 ${stackGapClass}`}>
                {eyebrow ? (
                    <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        {eyebrow}
                    </div>
                ) : null}
                <TitleTag className={`font-bold tracking-tight ${titleColorClass} ${titleClass}`}>
                    {title}
                </TitleTag>
                {description ? (
                    <p className="max-w-3xl text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                        {description}
                    </p>
                ) : null}
            </div>
            {actions ? <div className={`shrink-0 flex items-center ${actionsGapClass}`}>{actions}</div> : null}
        </div>
    );
}
