import React from 'react';

interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
    title: string;
    description?: string;
    action?: React.ReactNode;
    icon?: React.ReactNode;
}

export function EmptyState({ className = '', title, description, action, icon, ...props }: EmptyStateProps) {
    return (
        <div className={`rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center dark:border-slate-700 dark:bg-slate-900/50 ${className}`} {...props}>
            {icon ? <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white text-gray-500 dark:bg-slate-800 dark:text-gray-300">{icon}</div> : null}
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h3>
            {description ? <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p> : null}
            {action ? <div className="mt-4">{action}</div> : null}
        </div>
    );
}
