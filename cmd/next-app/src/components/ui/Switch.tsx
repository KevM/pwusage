'use client';

import React from 'react';

interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
    checked?: boolean;
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    name?: string;
    value?: string;
}

export function Switch({
    checked,
    defaultChecked = false,
    onCheckedChange,
    disabled,
    className = '',
    name,
    value = 'on',
    ...props
}: SwitchProps) {
    const isControlled = typeof checked === 'boolean';
    const [internalChecked, setInternalChecked] = React.useState(defaultChecked);
    const currentChecked = isControlled ? checked : internalChecked;

    const toggle = () => {
        if (disabled) return;
        const next = !currentChecked;
        if (!isControlled) {
            setInternalChecked(next);
        }
        onCheckedChange?.(next);
    };

    return (
        <>
            <button
                type="button"
                role="switch"
                aria-checked={currentChecked}
                disabled={disabled}
                onClick={toggle}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${currentChecked ? 'bg-primary' : 'bg-gray-300 dark:bg-slate-700'} ${className}`}
                {...props}
            >
                <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${currentChecked ? 'translate-x-5' : 'translate-x-0.5'}`}
                />
            </button>
            {name ? <input type="hidden" name={name} value={currentChecked ? value : ''} /> : null}
        </>
    );
}
