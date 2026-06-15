import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'outline';
    size?: 'sm' | 'md' | 'lg';
    appearance?: 'default' | 'glyph' | 'icon';
    icon?: React.ReactNode;
    iconPosition?: 'left' | 'right';
    renderAs?: 'button' | 'span';
}

export function Button({
    children,
    variant = 'primary',
    size = 'md',
    appearance = 'default',
    icon,
    iconPosition = 'left',
    renderAs = 'button',
    className = '',
    ...props
}: ButtonProps) {

    // Base styles that apply to all buttons
    const baseStyles = "inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-bg-base dark:ring-offset-slate-900 disabled:pointer-events-none disabled:cursor-not-allowed";

    // Variant styles utilizing the new Frosted theme
    const variants = {
        primary: "bg-primary text-bg-base hover:bg-primary/90 shadow-sm disabled:bg-gray-200 disabled:text-gray-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-500 disabled:shadow-none",
        secondary: "bg-secondary text-gray-900 dark:text-gray-100 hover:bg-secondary/80 disabled:bg-gray-200 disabled:text-gray-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-500",
        outline: "border border-secondary bg-transparent hover:bg-bg-muted text-gray-900 dark:text-gray-100 dark:hover:text-gray-900 disabled:border-gray-200 disabled:text-gray-400 dark:disabled:border-slate-800 dark:disabled:text-slate-500"
    };

    const sizes = {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4 py-2 text-sm",
        lg: "h-12 px-8 text-base",
    };

    const glyphSizes = {
        sm: "h-8 w-8",
        md: "h-10 w-10",
        lg: "h-11 w-11",
    };

    const glyphStyles = "rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800";

    const resolvedStyles = appearance === 'glyph'
        ? `${baseStyles} ${glyphStyles} ${glyphSizes[size]}`
        : `${baseStyles} ${variants[variant]} ${sizes[size]} ${appearance === 'icon' ? 'gap-2' : ''}`;

    const content = (
        <>
            {appearance === 'icon' && icon && iconPosition === 'left' ? <span className="shrink-0">{icon}</span> : null}
            {children}
            {appearance === 'icon' && icon && iconPosition === 'right' ? <span className="shrink-0">{icon}</span> : null}
        </>
    );

    if (renderAs === 'span') {
        return <span className={`${resolvedStyles} ${className}`}>{content}</span>;
    }

    return (
        <button
            className={`${resolvedStyles} ${className}`}
            tabIndex={props.disabled ? -1 : (props.tabIndex ?? 0)}
            {...props}
        >
            {content}
        </button>
    );
}
