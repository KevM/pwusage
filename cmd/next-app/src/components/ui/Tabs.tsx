'use client';

import React, { createContext, useContext } from 'react';

interface TabsContextValue {
    value: string;
    onValueChange: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
    value: string;
    onValueChange: (value: string) => void;
}

export function Tabs({ value, onValueChange, className = '', children, ...props }: TabsProps) {
    return (
        <TabsContext.Provider value={{ value, onValueChange }}>
            <div className={className} {...props}>{children}</div>
        </TabsContext.Provider>
    );
}

export function TabsList({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`inline-flex rounded-full bg-gray-100 p-1.5 shadow-inner dark:bg-slate-800 ${className}`} role="tablist" {...props}>
            {children}
        </div>
    );
}

interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    value: string;
}

export function TabsTrigger({ value, className = '', children, ...props }: TabsTriggerProps) {
    const ctx = useContext(TabsContext);
    if (!ctx) throw new Error('TabsTrigger must be used inside Tabs');

    const isActive = ctx.value === value;

    return (
        <button
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => ctx.onValueChange(value)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-white text-gray-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-gray-500 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'} ${className}`}
            {...props}
        >
            {children}
        </button>
    );
}

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
    value: string;
}

export function TabsContent({ value, className = '', children, ...props }: TabsContentProps) {
    const ctx = useContext(TabsContext);
    if (!ctx) throw new Error('TabsContent must be used inside Tabs');
    if (ctx.value !== value) return null;

    return <div role="tabpanel" className={className} {...props}>{children}</div>;
}
