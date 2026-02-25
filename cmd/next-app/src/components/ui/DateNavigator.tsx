import React from 'react';
import Link from 'next/link';

export function DateNavigator({ isCustom, className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement> & { isCustom?: boolean }) {
    return (
        <div
            className={`flex items-center gap-1 bg-bg-base dark:bg-slate-900 rounded-lg p-1 shadow-sm border ${isCustom ? 'border-primary ring-1 ring-primary' : 'border-gray-200 dark:border-slate-800'} shrink-0 ${className}`}
            {...props}
        >
            {children}
        </div>
    );
}

export function DateNavigatorButton({ href, onClick, direction, disabled }: { href?: string, onClick?: () => void, direction: 'prev' | 'next', disabled?: boolean }) {
    const icon = direction === 'prev' ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
        </svg>
    ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
        </svg>
    );

    if (disabled) {
        return (
            <button disabled className="p-1.5 text-gray-300 dark:text-gray-700 cursor-not-allowed rounded-md flex-none">
                {icon}
            </button>
        );
    }

    const btnClass = "p-1.5 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-bg-muted dark:hover:bg-slate-800 rounded-md transition-colors flex-none cursor-pointer";

    if (href) {
        return <Link href={href} className={btnClass} title={direction === 'prev' ? 'Previous' : 'Next'}>{icon}</Link>;
    }
    return <button type="button" onClick={onClick} className={btnClass} title={direction === 'prev' ? 'Previous' : 'Next'}>{icon}</button>;
}

export function DateNavigatorContent({ children, className = '' }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`relative group text-center min-w-[150px] flex-1 ${className}`}>
            {children}
        </div>
    );
}

export function DateNavigatorLabel({
    children,
    onClick,
    isCustom,
    className = '',
    ...props
}: React.HTMLAttributes<HTMLDivElement> & { isCustom?: boolean }) {
    return (
        <div
            onClick={onClick}
            className={`font-semibold text-sm hover:bg-bg-muted dark:hover:bg-slate-800 cursor-pointer rounded px-2 py-1 transition-colors w-full h-full flex items-center justify-center select-none text-gray-900 dark:text-white ${className}`}
            {...props}
        >
            {children}
            {isCustom && <span className="ml-2 text-xs bg-bg-muted text-primary px-1.5 py-0.5 rounded-full font-medium">Custom</span>}
        </div>
    );
}
