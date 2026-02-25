import React from 'react';

export function H1({ className = '', children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
    return (
        <h1 className={`text-4xl font-bold tracking-tight text-primary ${className}`} {...props}>
            {children}
        </h1>
    );
}

export function H2({ className = '', children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
    return (
        <h2 className={`text-2xl font-semibold text-gray-900 dark:text-white ${className}`} {...props}>
            {children}
        </h2>
    );
}

export function H3({ className = '', children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
    return (
        <h3 className={`text-lg font-medium text-gray-700 dark:text-gray-200 ${className}`} {...props}>
            {children}
        </h3>
    );
}

export function P({ className = '', children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
    return (
        <p className={`text-base text-gray-600 dark:text-gray-300 leading-relaxed ${className}`} {...props}>
            {children}
        </p>
    );
}
