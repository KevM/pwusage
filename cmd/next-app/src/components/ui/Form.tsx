import React from 'react';

export function Label({ className = '', children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
    return (
        <label className={`text-sm font-medium leading-none text-gray-700 dark:text-gray-300 peer-disabled:cursor-not-allowed peer-disabled:opacity-70 ${className}`} {...props}>
            {children}
        </label>
    );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    ({ className = '', type, ...props }, ref) => {
        return (
            <input
                type={type}
                className={`flex h-10 w-full rounded-md border border-gray-300 dark:border-slate-700 bg-bg-base dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-white shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50 dark:disabled:bg-slate-900 ${className}`}
                ref={ref}
                {...props}
            />
        );
    }
);
Input.displayName = 'Input';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
    ({ className = '', ...props }, ref) => {
        return (
            <select
                className={`flex h-10 w-full rounded-md border border-gray-300 dark:border-slate-700 bg-bg-base dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-white shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
                ref={ref}
                {...props}
            />
        );
    }
);
Select.displayName = 'Select';

export const Radio = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
    ({ className = '', ...props }, ref) => {
        return (
            <input
                type="radio"
                className={`h-4 w-4 rounded-full border border-gray-300 dark:border-slate-700 text-primary focus:ring-primary focus:ring-offset-2 dark:bg-slate-800 dark:ring-offset-slate-900 dark:checked:bg-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
                ref={ref}
                {...props}
            />
        );
    }
);
Radio.displayName = 'Radio';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
    ({ className = '', ...props }, ref) => {
        return (
            <textarea
                className={`flex min-h-24 w-full rounded-md border border-gray-300 dark:border-slate-700 bg-bg-base dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-white shadow-sm transition-colors placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50 dark:disabled:bg-slate-900 ${className}`}
                ref={ref}
                {...props}
            />
        );
    }
);
Textarea.displayName = 'Textarea';

export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
    ({ className = '', ...props }, ref) => {
        return (
            <input
                type="checkbox"
                className={`h-4 w-4 rounded border border-gray-300 dark:border-slate-700 text-primary focus:ring-primary focus:ring-offset-2 dark:bg-slate-800 dark:ring-offset-slate-900 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
                ref={ref}
                {...props}
            />
        );
    }
);
Checkbox.displayName = 'Checkbox';
