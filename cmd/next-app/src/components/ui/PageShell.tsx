import React from 'react';

type PageShellWidth = 'md' | 'lg' | 'xl' | '2xl' | '4xl' | '6xl' | '7xl' | 'full';
type PageShellPadding = 'none' | 'compact' | 'default' | 'relaxed';

export interface PageShellProps extends React.HTMLAttributes<HTMLDivElement> {
    maxWidth?: PageShellWidth;
    padding?: PageShellPadding;
    fullHeight?: boolean;
}

export function PageShell({
    className = '',
    children,
    maxWidth = '6xl',
    padding = 'default',
    fullHeight = true,
    ...props
}: PageShellProps) {
    const maxWidthClass = {
        md: 'max-w-3xl',
        lg: 'max-w-4xl',
        xl: 'max-w-5xl',
        '2xl': 'max-w-6xl',
        '4xl': 'max-w-7xl',
        '6xl': 'max-w-screen-xl',
        '7xl': 'max-w-screen-2xl',
        full: 'max-w-none',
    }[maxWidth];

    const paddingClass = {
        none: '',
        compact: 'px-4 py-4 sm:px-6 sm:py-6',
        default: 'px-4 py-6 sm:px-6 sm:py-8',
        relaxed: 'px-4 py-8 sm:px-6 sm:py-10 lg:px-8 lg:py-12',
    }[padding];

    return (
        <div
            className={`${fullHeight ? 'min-h-screen' : ''} mx-auto w-full ${maxWidthClass} ${paddingClass} ${className}`}
            {...props}
        >
            {children}
        </div>
    );
}
