import React from 'react';

export function Skeleton({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={`animate-pulse rounded-md bg-gray-200 dark:bg-slate-800 ${className}`} {...props} />;
}
