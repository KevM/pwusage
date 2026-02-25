import React from 'react';

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
    variant?: 'info' | 'success' | 'warning' | 'danger';
}

export function Alert({ className = '', variant = 'info', children, ...props }: AlertProps) {
    const variants = {
        info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
        success: 'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200',
        warning: 'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200',
        danger: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
    };

    return (
        <div className={`rounded-lg border p-4 ${variants[variant]} ${className}`} role="alert" {...props}>
            {children}
        </div>
    );
}

export function AlertTitle({ className = '', children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
    return (
        <h4 className={`mb-1 text-sm font-semibold ${className}`} {...props}>
            {children}
        </h4>
    );
}

export function AlertDescription({ className = '', children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
    return (
        <p className={`text-sm ${className}`} {...props}>
            {children}
        </p>
    );
}
