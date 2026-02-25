import React from 'react';

type CardDensity = 'default' | 'compact';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
    density?: CardDensity;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
    { className = '', children, density = 'default', ...props },
    ref
) {
    const densityClass = density === 'compact' ? 'rounded-lg' : 'rounded-xl';

    return (
        <div
            ref={ref}
            className={`bg-bg-base dark:bg-slate-900 shadow-sm border border-gray-200 dark:border-slate-800 ${densityClass} ${className}`}
            {...props}
        >
            {children}
        </div>
    );
});

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
    action?: React.ReactNode;
    density?: CardDensity;
}

export function CardHeader({ className = '', action, children, density = 'default', ...props }: CardHeaderProps) {
    const headerPaddingClass = density === 'compact' ? 'p-3 pb-2' : 'p-6 pb-4';
    const headerSpacingClass = density === 'compact' ? 'space-y-1' : 'space-y-1.5';

    if (action) {
        return (
            <div className={`flex flex-row items-start justify-between ${headerPaddingClass} border-b border-gray-100 dark:border-slate-800/60 gap-4 ${className}`} {...props}>
                <div className={`flex flex-col ${headerSpacingClass} flex-1 min-w-0`}>
                    {children}
                </div>
                <div className="shrink-0 z-10 flex items-center justify-end">
                    {action}
                </div>
            </div>
        );
    }

    return (
        <div className={`flex flex-col ${headerSpacingClass} ${headerPaddingClass} border-b border-gray-100 dark:border-slate-800/60 ${className}`} {...props}>
            {children}
        </div>
    );
}

export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
    density?: CardDensity;
}

export function CardTitle({ className = '', children, density = 'default', ...props }: CardTitleProps) {
    const titleClass = density === 'compact' ? 'text-base' : 'text-xl';

    return (
        <h3 className={`font-semibold ${titleClass} leading-none tracking-tight text-gray-900 dark:text-white ${className}`} {...props}>
            {children}
        </h3>
    );
}

export function CardDescription({ className = '', children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
    return (
        <p className={`text-sm text-gray-500 dark:text-gray-400 ${className}`} {...props}>
            {children}
        </p>
    );
}

export interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {
    density?: CardDensity;
}

export function CardContent({ className = '', children, density = 'default', ...props }: CardContentProps) {
    const contentPaddingClass = density === 'compact' ? 'p-3 pt-0 mt-2' : 'p-6 pt-0 mt-4';

    return (
        <div className={`${contentPaddingClass} ${className}`} {...props}>
            {children}
        </div>
    );
}

export interface CardBodyProps extends React.HTMLAttributes<HTMLDivElement> {
    density?: CardDensity;
}

export function CardBody({ className = '', children, density = 'default', ...props }: CardBodyProps) {
    const bodyPaddingClass = density === 'compact' ? 'p-3' : 'p-6';

    return (
        <div className={`${bodyPaddingClass} ${className}`} {...props}>
            {children}
        </div>
    );
}
