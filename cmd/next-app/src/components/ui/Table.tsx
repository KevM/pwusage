import React from 'react';

export function Table({ className = '', children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
    return (
        <div className="w-full overflow-x-auto">
            <table className={`min-w-full text-left text-sm ${className}`} {...props}>
                {children}
            </table>
        </div>
    );
}

export function TableHeader({ className = '', children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
    return <thead className={`bg-gray-50 dark:bg-slate-900 ${className}`} {...props}>{children}</thead>;
}

export function TableBody({ className = '', children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
    return <tbody className={`divide-y divide-gray-200 dark:divide-slate-800 ${className}`} {...props}>{children}</tbody>;
}

export function TableRow({ className = '', children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
    return <tr className={`bg-white dark:bg-slate-900 ${className}`} {...props}>{children}</tr>;
}

export function TableHead({ className = '', children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
    return (
        <th
            className={`px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 ${className}`}
            {...props}
        >
            {children}
        </th>
    );
}

export function TableCell({ className = '', children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
    return <td className={`px-4 py-3 text-gray-700 dark:text-gray-200 ${className}`} {...props}>{children}</td>;
}
