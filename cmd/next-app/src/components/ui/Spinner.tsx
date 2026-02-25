import React from 'react';

interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
    size?: 'sm' | 'md' | 'lg';
}

export function Spinner({ className = '', size = 'md', ...props }: SpinnerProps) {
    const sizes = {
        sm: 'h-4 w-4 border-2',
        md: 'h-5 w-5 border-2',
        lg: 'h-7 w-7 border-[3px]',
    };

    return (
        <span
            className={`inline-block animate-spin rounded-full border-current border-t-transparent text-primary ${sizes[size]} ${className}`}
            role="status"
            aria-label="Loading"
            {...props}
        />
    );
}
