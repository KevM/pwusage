'use client';

import React, { createContext, useContext, useMemo, useState } from 'react';

export interface ToastOptions {
    title: string;
    description?: string;
    variant?: 'default' | 'success' | 'warning' | 'danger';
    durationMs?: number;
}

interface ToastItem extends Required<Omit<ToastOptions, 'durationMs'>> {
    id: string;
    durationMs: number;
}

interface ToastContextValue {
    toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    const api = useMemo<ToastContextValue>(() => ({
        toast: ({ title, description = '', variant = 'default', durationMs = 3000 }: ToastOptions) => {
            const id = crypto.randomUUID();
            const toastItem: ToastItem = { id, title, description, variant, durationMs };
            setToasts((prev) => [...prev, toastItem]);
            window.setTimeout(() => {
                setToasts((prev) => prev.filter((t) => t.id !== id));
            }, durationMs);
        },
    }), []);

    const variantStyles: Record<ToastItem['variant'], string> = {
        default: 'border-gray-200 bg-white text-gray-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white',
        success: 'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200',
        warning: 'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200',
        danger: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
    };

    return (
        <ToastContext.Provider value={api}>
            {children}
            <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
                {toasts.map((t) => (
                    <div key={t.id} className={`pointer-events-auto rounded-lg border p-3 shadow-sm ${variantStyles[t.variant]}`}>
                        <p className="text-sm font-semibold">{t.title}</p>
                        {t.description ? <p className="mt-0.5 text-xs opacity-90">{t.description}</p> : null}
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used within ToastProvider');
    return ctx;
}
